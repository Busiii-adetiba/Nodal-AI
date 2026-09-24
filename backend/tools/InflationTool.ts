/**
 * backend/tools/InflationTool.ts
 * Configure and query the account inflation destination via SET_OPTIONS.
 *
 * Stellar accounts may nominate an inflation destination that receives the
 * network's inflation pool payouts. The destination can only be set or
 * changed — it cannot be cleared — so the mutation surface is a single
 * `set` action backed by an `Operation.setOptions` wrapper, plus a read-only
 * `get` action backed by a Horizon account lookup.
 */

import { Keypair, TransactionBuilder, Operation, BASE_FEE } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { loadAccount, submitTransaction, resolveNetworkPassphrase } from '../rpc_client';
import { SubmitResultSchema } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';

export const InflationInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    inflationDestination: stellarPublicKeySchema('Inflation destination'),
  }),
  z.object({
    action: z.literal('get'),
    accountId: stellarPublicKeySchema('accountId').optional(),
  }),
]);

export type InflationInput = z.infer<typeof InflationInputSchema>;

export interface InflationSetResult {
  action: 'set';
  txHash: string;
  ledger: number;
  inflationDestination: string;
}

export interface InflationGetResult {
  action: 'get';
  accountId: string;
  /** The account's inflation destination, or null when none is set. */
  inflationDestination: string | null;
  isSet: boolean;
}

export type InflationResult = InflationSetResult | InflationGetResult;

export class InflationTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  /** Read the inflation destination for an account (defaults to the agent's own). */
  async get(accountId?: string): Promise<InflationGetResult> {
    const targetAccount = accountId ?? this.keypair.publicKey();
    const account = await loadAccount(targetAccount);
    const inflationDestination = account.inflation_destination ?? null;

    return {
      action: 'get',
      accountId: targetAccount,
      inflationDestination,
      isSet: inflationDestination !== null,
    };
  }

  /** Nominate an inflation destination for the agent account via SET_OPTIONS. */
  async set(inflationDestination: string): Promise<InflationSetResult> {
    const account = await loadAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.setOptions({
          inflationDest: inflationDestination,
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    tx.sign(this.keypair);
    const result = SubmitResultSchema.parse(await submitTransaction(tx));

    return {
      action: 'set',
      txHash: result.hash,
      ledger: result.ledger,
      inflationDestination,
    };
  }

  async execute(rawInput: unknown): Promise<InflationResult> {
    const input = InflationInputSchema.parse(rawInput);

    if (input.action === 'get') {
      return this.get(input.accountId);
    }

    return this.set(input.inflationDestination);
  }
}
