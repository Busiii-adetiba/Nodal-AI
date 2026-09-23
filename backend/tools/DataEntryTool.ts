/**
 * backend/tools/DataEntryTool.ts
 * Read, write, and delete Stellar account data entries via MANAGE_DATA.
 */

import { Keypair, TransactionBuilder, Operation, BASE_FEE, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { loadAccount, submitTransaction, resolveNetworkPassphrase } from '../rpc_client';
import { SubmitResultSchema } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

export const DataEntryInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    name: z.string().min(1).max(64, 'Data name must be <= 64 bytes'),
    value: z.string().max(64, 'Data value must be <= 64 bytes'),
  }),
  z.object({
    action: z.literal('delete'),
    name: z.string().min(1).max(64, 'Data name must be <= 64 bytes'),
  }),
  z.object({
    action: z.literal('get'),
    name: z.string().min(1).max(64, 'Data name must be <= 64 bytes'),
    accountId: z
      .string()
      .length(56, 'Invalid Stellar public key')
      .refine((val) => StrKey.isValidEd25519PublicKey(val), 'Invalid Stellar public key')
      .optional(),
  }),
]);

export type DataEntryInput = z.infer<typeof DataEntryInputSchema>;

export interface DataEntryGetResult {
  name: string;
  accountId: string;
  exists: boolean;
  value: string | null;
  utf8?: string | null;
  hex?: string | null;
  rawBase64?: string | null;
}

export interface DataEntryMutationResult {
  txHash: string;
  ledger: number;
  name: string;
  action: 'set' | 'delete';
}

export type DataEntryResult = DataEntryGetResult | DataEntryMutationResult;

export class DataEntryTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async get(name: string, accountId?: string): Promise<DataEntryGetResult> {
    const targetAccount = accountId ?? this.keypair.publicKey();
    const account = await loadAccount(targetAccount);
    const rawBase64 = (account.data_attr as Record<string, string> | undefined)?.[name];

    if (rawBase64 === undefined) {
      return {
        name,
        accountId: targetAccount,
        exists: false,
        value: null,
      };
    }

    const buf = Buffer.from(rawBase64, 'base64');
    const utf8Val = buf.toString('utf8');
    const hexVal = buf.toString('hex');

    return {
      name,
      accountId: targetAccount,
      exists: true,
      value: utf8Val,
      utf8: utf8Val,
      hex: hexVal,
      rawBase64,
    };
  }

  async execute(rawInput: unknown): Promise<DataEntryResult> {
    const input = DataEntryInputSchema.parse(rawInput);

    if (input.action === 'get') {
      return this.get(input.name, input.accountId);
    }

    const account = await loadAccount(this.keypair.publicKey());
    const opValue = input.action === 'delete' ? null : input.value;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.manageData({
          name: input.name,
          value: opValue,
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    tx.sign(this.keypair);
    const result = SubmitResultSchema.parse(await submitTransaction(tx));
    return {
      txHash: result.hash,
      ledger: result.ledger,
      name: input.name,
      action: input.action,
    };
  }
}
