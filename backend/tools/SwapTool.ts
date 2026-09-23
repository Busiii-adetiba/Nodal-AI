/**
 * backend/tools/SwapTool.ts
 * Atomic DEX swap via strict-send path discovery and path payment submission.
 */

import { Asset } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { ValidationError } from '../errors';
import { horizonServer, withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';
import { PathPaymentTool } from './PathPaymentTool';

const AssetSchema = z.object({
  code: z.string(),
  issuer: z.string().optional(),
});

export const SwapInputSchema = z.object({
  sellAsset: AssetSchema,
  buyAsset: AssetSchema,
  sellAmount: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'sellAmount must be a valid Stellar decimal')
    .refine((v) => parseFloat(v) > 0, 'sellAmount must be greater than zero'),
  maxSlippagePct: z
    .number()
    .min(0, 'maxSlippagePct must be at least 0')
    .max(100, 'maxSlippagePct must be at most 100'),
});

export type SwapInput = z.infer<typeof SwapInputSchema>;

function toAsset(a: { code: string; issuer?: string | undefined }): Asset {
  if (a.code === 'XLM') return Asset.native();
  if (!a.issuer) {
    throw new ValidationError(`Asset issuer is required for non-native asset ${a.code}`);
  }
  return new Asset(a.code, a.issuer);
}

function pathAssetsFromRecord(
  path: Array<{ asset_code: string; asset_issuer?: string; asset_type: string }>
): Array<{ code: string; issuer?: string }> {
  return path.map((step) => {
    if (step.asset_type === 'native') {
      return { code: 'XLM' };
    }
    const asset: { code: string; issuer?: string } = { code: step.asset_code };
    if (step.asset_issuer) {
      asset.issuer = step.asset_issuer;
    }
    return asset;
  });
}

export class SwapTool {
  private pathPaymentTool: PathPaymentTool;

  constructor(secretKey?: string) {
    this.pathPaymentTool = new PathPaymentTool(secretKey);
  }

  get publicKey(): string {
    return this.pathPaymentTool.publicKey;
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const input = SwapInputSchema.parse(rawInput);

    const sellAsset = toAsset(input.sellAsset);
    const buyAsset = toAsset(input.buyAsset);

    const response = await withBackoffGuard(() =>
      withRetry(
        () => horizonServer.strictSendPaths(sellAsset, input.sellAmount, [buyAsset]).call(),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );

    if (response.records.length === 0) {
      throw new ValidationError('No swap path found for the requested assets');
    }

    const amounts = response.records.map((record) => parseFloat(record.destination_amount));
    const bestAmount = Math.max(...amounts);
    const worstAmount = Math.min(...amounts);

    if (bestAmount <= 0) {
      throw new ValidationError('Swap path returned zero destination amount');
    }

    const deviationPct = ((bestAmount - worstAmount) / bestAmount) * 100;
    if (deviationPct > input.maxSlippagePct) {
      throw new ValidationError(
        `Slippage deviation ${deviationPct.toFixed(2)}% exceeds tolerance ${input.maxSlippagePct}%`
      );
    }

    const bestPath = response.records.reduce((currentBest, candidate) =>
      parseFloat(candidate.destination_amount) > parseFloat(currentBest.destination_amount)
        ? candidate
        : currentBest
    );

    const destMinAmount = (bestAmount * (1 - input.maxSlippagePct / 100)).toFixed(7);

    return this.pathPaymentTool.execute({
      destination: this.publicKey,
      sendAsset: input.sellAsset,
      sendAmount: input.sellAmount,
      destAsset: input.buyAsset,
      destMinAmount,
      path: pathAssetsFromRecord(bestPath.path),
      allowSelfPayment: true,
    });
  }
}
