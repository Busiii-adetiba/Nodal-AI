/**
 * backend/tools/SequenceNumberTool.ts
 * Fetch and bump Stellar account sequence numbers via BUMP_SEQUENCE.
 */

import { Keypair, TransactionBuilder, Operation, BASE_FEE } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { loadAccount, submitTransaction, resolveNetworkPassphrase } from '../rpc_client';
import { SubmitResultSchema } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';

export const SequenceNumberInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('get'),
    accountId: stellarPublicKeySchema('accountId').optional(),
  }),
  z.object({
    action: z.literal('bump'),
    bumpTo: z
      .union([z.string().min(1), z.number().int().positive(), z.bigint()])
      .transform((v) => String(v)),
  }),
]);

export type SequenceNumberInput = z.infer<typeof SequenceNumberInputSchema>;

export interface SequenceNumberGetResult {
  accountId: string;
  sequence: string;
}

export interface SequenceNumberBumpResult {
  txHash: string;
  ledger: number;
  bumpedTo: string;
  sequence: string;
}

export type SequenceNumberResult = SequenceNumberGetResult | SequenceNumberBumpResult;

export class SequenceNumberTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async get(accountId?: string): Promise<SequenceNumberGetResult> {
    const targetAccount = accountId ?? this.keypair.publicKey();
    const account = await loadAccount(targetAccount, { forceRefresh: true });
    return {
      accountId: targetAccount,
      sequence: account.sequenceNumber(),
    };
  }

  async bump(bumpTo: string): Promise<SequenceNumberBumpResult> {
    const account = await loadAccount(this.keypair.publicKey(), { forceRefresh: true });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.bumpSequence({
          bumpTo: String(bumpTo),
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    tx.sign(this.keypair);
    const result = SubmitResultSchema.parse(await submitTransaction(tx));

    return {
      txHash: result.hash,
      ledger: result.ledger,
      bumpedTo: String(bumpTo),
      sequence: String(bumpTo),
    };
  }

  async execute(rawInput: unknown): Promise<SequenceNumberResult> {
    const input = SequenceNumberInputSchema.parse(rawInput);

    if (input.action === 'get') {
      return this.get(input.accountId);
    }

    return this.bump(input.bumpTo);
  }
}
