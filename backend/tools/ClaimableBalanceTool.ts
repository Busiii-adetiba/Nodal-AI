/**
 * backend/tools/ClaimableBalanceTool.ts
 * Create and claim Stellar claimable balances.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Claimant,
  BASE_FEE,
  } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import {
  loadAccount,
  submitTransaction,
  horizonServer,
  resolveNetworkPassphrase,
} from '../rpc_client';
import { SubmitResultSchema } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';

const ClaimPredicateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unconditional') }),
  z.object({ type: z.literal('beforeAbsoluteTime'), timestamp: z.number().int().positive() }),
]);

const ClaimantSchema = z.object({
  destination: stellarPublicKeySchema('Claimant public key'),
  predicate: ClaimPredicateSchema.optional(),
});

const CreateClaimableBalanceSchema = z.object({
  action: z.literal('create'),
  assetCode: z.string().min(1).max(12),
  assetIssuer: stellarPublicKeySchema('Asset issuer').optional(),
  amount: z.string().min(1),
  claimants: z.array(ClaimantSchema).min(1),
});

const ClaimClaimableBalanceSchema = z.object({
  action: z.literal('claim'),
  balanceId: z.string().min(1),
});

export const ClaimableBalanceInputSchema = z.discriminatedUnion('action', [
  CreateClaimableBalanceSchema,
  ClaimClaimableBalanceSchema,
]);

export type ClaimableBalanceInput = z.infer<typeof ClaimableBalanceInputSchema>;

function buildPredicate(
  predicate: z.infer<typeof ClaimPredicateSchema> | undefined
): ReturnType<typeof Claimant.predicateUnconditional> {
  if (!predicate || predicate.type === 'unconditional') {
    return Claimant.predicateUnconditional();
  }
  return Claimant.predicateBeforeAbsoluteTime(String(predicate.timestamp));
}

export class ClaimableBalanceTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  private async verifyClaimant(balanceId: string): Promise<void> {
    const balance = await horizonServer
      .claimableBalances()
      .claimant(this.keypair.publicKey())
      .call();
    const records = (balance as { records?: Array<{ id: string }> }).records ?? [];
    const isClaimant = records.some((record) => record.id === balanceId);
    if (!isClaimant) {
      throw new Error(`Agent is not a claimant for balance ${balanceId}`);
    }
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const input = ClaimableBalanceInputSchema.parse(rawInput);
    const account = await loadAccount(this.keypair.publicKey());

    if (input.action === 'create') {
      const asset =
        input.assetCode === 'XLM' && !input.assetIssuer
          ? Asset.native()
          : new Asset(input.assetCode, input.assetIssuer!);

      const claimants = input.claimants.map(
        (c) => new Claimant(c.destination, buildPredicate(c.predicate))
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.createClaimableBalance({
            asset,
            amount: input.amount,
            claimants,
          })
        )
        .setTimeout(SOROBAN_TX_TIMEOUT)
        .build();

      tx.sign(this.keypair);
      const result = SubmitResultSchema.parse(await submitTransaction(tx));
      return { txHash: result.hash, ledger: result.ledger };
    }

    await this.verifyClaimant(input.balanceId);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.claimClaimableBalance({
          balanceId: input.balanceId,
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    tx.sign(this.keypair);
    const result = SubmitResultSchema.parse(await submitTransaction(tx));
    return { txHash: result.hash, ledger: result.ledger };
  }
}
