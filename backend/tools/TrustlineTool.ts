/**
 * backend/tools/TrustlineTool.ts
 * Manage asset trustlines for the agent account.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  StrKey,
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
import { ValidationError } from '../errors';
import { BalanceCheckTool } from './BalanceCheckTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

export const TrustlineInputSchema = z.object({
  assetCode: z.string().min(1).max(12),
  assetIssuer: z
    .string()
    .length(56, 'Invalid asset issuer address')
    .refine(
      (val) => StrKey.isValidEd25519PublicKey(val),
      'Asset issuer must be a valid Stellar public key'
    ),
  action: z.enum(['add', 'remove']),
  limit: z.string().optional(),
});

export type TrustlineInput = z.infer<typeof TrustlineInputSchema>;

export class TrustlineTool {
  private keypair: Keypair;
  private networkPassphrase: string;
  private balanceCheckTool: BalanceCheckTool;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
    this.balanceCheckTool = new BalanceCheckTool();
  }

  async checkTrustline(assetCode: string, assetIssuer: string): Promise<boolean> {
    const account = await loadAccount(this.keypair.publicKey());
    return (account.balances as any[]).some(
      (b) =>
        b.asset_type !== 'native' && b.asset_code === assetCode && b.asset_issuer === assetIssuer
    );
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const input = TrustlineInputSchema.parse(rawInput);
    const asset = new Asset(input.assetCode, input.assetIssuer);
    const account = await loadAccount(this.keypair.publicKey());

    if (input.action === 'remove') {
      const balance = await this.balanceCheckTool.execute({
        publicKey: this.keypair.publicKey(),
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
      });
      if (Number(balance) > 0) {
        throw new ValidationError(
          `Cannot remove trustline: non-zero balance of ${input.assetCode}`
        );
      }
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset,
          ...(input.action === 'remove'
            ? { limit: '0' }
            : input.limit
              ? { limit: input.limit }
              : {}),
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    tx.sign(this.keypair);
    const result = SubmitResultSchema.parse(await submitTransaction(tx));
    return { txHash: result.hash, ledger: result.ledger };
  }
}
