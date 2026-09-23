/**
 * backend/tools/DexOfferTool.ts
 * Place, update, or delete a manage-sell offer on the Stellar DEX.
 */

import { Keypair, TransactionBuilder, Operation, Asset, BASE_FEE, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { NotFoundError } from '@stellar/stellar-sdk';
import { config } from '../config';
import { ValidationError } from '../errors';
import {
  DEFAULT_IS_RETRYABLE,
  horizonServer,
  loadAccount,
  resolveNetworkPassphrase,
  submitTransaction,
  withRetry,
} from '../rpc_client';
import { withBackoffGuard } from '../network';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';
import { SubmitResultSchema } from './StellarPaymentTool';

/**
 * Extract offer ID from the transaction result XDR.
 * For manageSellOffer create operations, the result contains the offerID.
 */
function extractOfferIdFromTxResult(resultXdr: string, action: string): string | null {
  if (action !== 'create') return null;

  try {
    const txResult = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
    const result = txResult.result();
    if (result.switch() !== xdr.TransactionResultCode.txSuccess()) return null;

    const opResults = result.results();
    if (opResults.length === 0) return null;

    // opResults[0] is the OperationResult union
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opResult: any = opResults[0];
    if (opResult.switch() !== xdr.OperationResultCode.opInner()) {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tr: any = opResult.tr();
    if (tr.switch() !== xdr.OperationType.manageSellOffer()) {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const manageSellOfferResult: any = tr.manageSellOfferResult();
    const successResult = manageSellOfferResult.success();
    if (!successResult) return null;

    const offerUnion = successResult.offer();
    if (!offerUnion) return null;

    // After deserialization, the union arm is "offer", so use .value()
    const offer = offerUnion.value();
    if (!offer) return null;

    return offer.offerId().toString();
  } catch {
    return null;
  }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const AssetSchema = z.object({
  code: z.string(),
  issuer: z.string().optional(),
});

export const DexOfferInputSchema = z
  .object({
    action: z.enum(['create', 'update', 'delete']),
    selling: AssetSchema,
    buying: AssetSchema,
    amount: z
      .string()
      .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'Amount must be a valid Stellar decimal')
      .refine((v) => parseFloat(v) > 0, 'Amount must be greater than zero'),
    price: z.string().regex(/^\d+(\.\d+)?$/, 'Price must be a positive decimal'),
    offerId: z.union([z.string(), z.number()]).optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.action === 'update' || data.action === 'delete') && data.offerId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'offerId is required for update and delete actions',
        path: ['offerId'],
      });
    }
  });

export type DexOfferInput = z.infer<typeof DexOfferInputSchema>;

// ─── Helper ───────────────────────────────────────────────────────────────────

function resolveAsset(a: { code: string; issuer?: string | undefined }): Asset {
  return a.code === 'XLM' ? Asset.native() : new Asset(a.code, a.issuer!);
}

async function verifyOfferExists(offerId: string): Promise<void> {
  try {
    await withBackoffGuard(() =>
      withRetry(
        () => horizonServer.offers().offer(offerId).call(),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS,
        (err) => !(err instanceof NotFoundError) && DEFAULT_IS_RETRYABLE(err)
      )
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new ValidationError(`Offer ${offerId} not found on Stellar network`);
    }
    throw err;
  }
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export class DexOfferTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number; offerId: string }> {
    const input = DexOfferInputSchema.parse(rawInput);

    const selling = resolveAsset(input.selling);
    const buying = resolveAsset(input.buying);

    // For delete: amount must be "0" regardless of the validated input amount
    const offerAmount = input.action === 'delete' ? '0' : input.amount;
    const offerId = input.offerId != null ? String(input.offerId) : '0';

    if (input.action === 'update' || input.action === 'delete') {
      await verifyOfferExists(offerId);
    }

    const sourceAccount = await loadAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.manageSellOffer({
          selling,
          buying,
          amount: offerAmount,
          price: input.price,
          offerId,
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    tx.sign(this.keypair);

    const submitResult = await submitTransaction(tx);
    const result = SubmitResultSchema.parse(submitResult);

    // For create actions, extract the network-assigned offerId from the transaction result.
    // For update/delete actions, return the input offerId.
    let finalOfferId = offerId;
    if (input.action === 'create' && 'result_xdr' in submitResult) {
      const extractedOfferId = extractOfferIdFromTxResult(
        (submitResult as { result_xdr: string }).result_xdr,
        input.action
      );
      if (extractedOfferId) {
        finalOfferId = extractedOfferId;
      }
    }

    return { txHash: result.hash, ledger: result.ledger, offerId: finalOfferId };
  }
}
