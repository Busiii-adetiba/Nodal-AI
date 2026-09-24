/**
 * backend/tools/LiquidityPoolTool.ts
 * Tool for depositing, withdrawing liquidity, and fetching pool info on Stellar.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  LiquidityPoolAsset,
  LiquidityPoolParameters,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import {
  horizonServer,
  loadAccount,
  resolveNetworkPassphrase,
  submitTransaction,
  withRetry,
} from '../rpc_client';
import { withBackoffGuard } from '../network';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

const AssetSchema = z.object({
  code: z.string(),
  issuer: z.string().optional(),
});

export const LiquidityPoolInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('deposit'),
    liquidityPoolId: z.string().min(1, 'liquidityPoolId is required'),
    maxAmountA: z
      .string()
      .regex(
        /^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/,
        'maxAmountA must be a valid positive Stellar decimal'
      ),
    maxAmountB: z
      .string()
      .regex(
        /^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/,
        'maxAmountB must be a valid positive Stellar decimal'
      ),
    minPrice: z.string().regex(/^\d+(\.\d+)?$/, 'minPrice must be a positive decimal'),
    maxPrice: z.string().regex(/^\d+(\.\d+)?$/, 'maxPrice must be a positive decimal'),
  }),
  z.object({
    action: z.literal('withdraw'),
    liquidityPoolId: z.string().min(1, 'liquidityPoolId is required'),
    amount: z
      .string()
      .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'amount must be a valid positive Stellar decimal'),
    minAmountA: z.string().regex(/^\d+(\.\d{1,7})?$/, 'minAmountA must be a valid Stellar decimal'),
    minAmountB: z.string().regex(/^\d+(\.\d{1,7})?$/, 'minAmountB must be a valid Stellar decimal'),
  }),
  z.object({
    action: z.literal('info'),
    liquidityPoolId: z.string().min(1, 'liquidityPoolId is required'),
  }),
]);

export type LiquidityPoolInput = z.infer<typeof LiquidityPoolInputSchema>;

export interface LiquidityPoolInfoResult {
  id: string;
  pagingToken: string;
  feeBP: number;
  type: string;
  totalShares: string;
  totalTrustlines: string;
  reserves: Array<{
    asset: string;
    amount: string;
  }>;
}

export class LiquidityPoolTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async execute(
    rawInput: unknown
  ): Promise<{ txHash?: string; ledger?: number; poolInfo?: LiquidityPoolInfoResult }> {
    const input = LiquidityPoolInputSchema.parse(rawInput);

    if (input.action === 'info') {
      const res: any = await withBackoffGuard(() =>
        withRetry(
          () => horizonServer.liquidityPools().liquidityPoolId(input.liquidityPoolId).call(),
          config.MAX_RETRIES,
          config.RETRY_DELAY_MS
        )
      );

      const poolInfo: LiquidityPoolInfoResult = {
        id: res.id,
        pagingToken: res.paging_token,
        feeBP: res.fee_bp,
        type: res.type,
        totalShares: res.total_shares,
        totalTrustlines: res.total_trustlines,
        reserves: res.reserves.map((r: any) => ({
          asset: r.asset,
          amount: r.amount,
        })),
      };

      return { poolInfo };
    }

    const sourceAccount = await loadAccount(this.keypair.publicKey());
    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    if (input.action === 'deposit') {
      builder.addOperation(
        Operation.liquidityPoolDeposit({
          liquidityPoolId: input.liquidityPoolId,
          maxAmountA: input.maxAmountA,
          maxAmountB: input.maxAmountB,
          minPrice: input.minPrice,
          maxPrice: input.maxPrice,
        })
      );
    } else if (input.action === 'withdraw') {
      builder.addOperation(
        Operation.liquidityPoolWithdraw({
          liquidityPoolId: input.liquidityPoolId,
          amount: input.amount,
          minAmountA: input.minAmountA,
          minAmountB: input.minAmountB,
        })
      );
    }

    const tx = builder.setTimeout(SOROBAN_TX_TIMEOUT).build();
    tx.sign(this.keypair);

    const result = await submitTransaction(tx);
    return {
      txHash: result.hash,
      ledger: result.ledger,
    };
  }
}
