/**
 * backend/tools/SponsoredAccountTool.ts
 * Create sponsored reserve accounts on Stellar using BEGIN_SPONSORING_FUTURE_RESERVES,
 * CREATE_ACCOUNT, and END_SPONSORING_FUTURE_RESERVES.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  StrKey,
  xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { loadAccount, submitTransaction, resolveNetworkPassphrase } from '../rpc_client';
import { SubmitResultSchema } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

export const SponsoredAccountInputSchema = z.object({
  newAccountPublicKey: z
    .string()
    .length(56, 'Invalid Stellar public key')
    .refine((val) => StrKey.isValidEd25519PublicKey(val), 'Invalid Stellar public key'),
  startingBalance: z.string().default('0'),
  newAccountSignature: z.string().optional(),
  newAccountSecret: z.string().optional(),
});

export type SponsoredAccountInput = z.infer<typeof SponsoredAccountInputSchema>;

export interface SponsoredAccountResult {
  txHash: string;
  ledger: number;
  newAccountPublicKey: string;
  startingBalance: string;
}

export class SponsoredAccountTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async execute(rawInput: unknown): Promise<SponsoredAccountResult> {
    const input = SponsoredAccountInputSchema.parse(rawInput);
    const account = await loadAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: input.newAccountPublicKey,
        })
      )
      .addOperation(
        Operation.createAccount({
          destination: input.newAccountPublicKey,
          startingBalance: input.startingBalance,
        })
      )
      .addOperation(
        Operation.endSponsoringFutureReserves({
          source: input.newAccountPublicKey,
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    // Agent signs first
    tx.sign(this.keypair);

    // Apply co-signature if provided
    if (input.newAccountSecret) {
      const newKeypair = Keypair.fromSecret(input.newAccountSecret);
      tx.sign(newKeypair);
    } else if (input.newAccountSignature) {
      try {
        const decoratedSig = xdr.DecoratedSignature.fromXDR(input.newAccountSignature, 'base64');
        tx.addDecoratedSignature(decoratedSig);
      } catch {
        try {
          const keypair = Keypair.fromPublicKey(input.newAccountPublicKey);
          const hint = keypair.rawPublicKey().slice(-4);
          const sigBuffer = Buffer.from(input.newAccountSignature, 'base64');
          const decorated = new xdr.DecoratedSignature({
            hint,
            signature: sigBuffer,
          });
          tx.addDecoratedSignature(decorated);
        } catch (err) {
          throw new Error(
            `Invalid newAccountSignature: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    const result = SubmitResultSchema.parse(await submitTransaction(tx));

    return {
      txHash: result.hash,
      ledger: result.ledger,
      newAccountPublicKey: input.newAccountPublicKey,
      startingBalance: input.startingBalance,
    };
  }
}
