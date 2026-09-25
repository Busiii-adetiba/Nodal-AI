/**
 * backend/tools/OfferBookTool.ts
 * Tool for querying the Stellar DEX order book and computing spread.
 */

import { Asset } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { horizonServer, withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';
import { createLogger } from '../utils/logger';

const log = createLogger('offer-book-tool');

// ─── Schemas & Types ──────────────────────────────────────────────────────────

const AssetDescriptorSchema = z.union([
  z.object({
    code: z.string(),
    issuer: z.string().optional(),
  }),
  z.instanceof(Asset),
  z.string(),
]);

export const OfferBookInputSchema = z.object({
  /** Asset being sold on the order book. */
  sellingAsset: AssetDescriptorSchema,

  /** Asset being bought on the order book. */
  buyingAsset: AssetDescriptorSchema,

  /** Optional max number of price levels to return (1-200). */
  limit: z.number().int().positive().max(200).optional(),
});

export type OfferBookInput = z.infer<typeof OfferBookInputSchema>;

export interface PriceLevel {
  price: string;
  price_r: { n: number; d: number };
  amount: string;
}

export interface OfferBookResult {
  bids: PriceLevel[];
  asks: PriceLevel[];
  spread: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

export function resolveAsset(input: OfferBookInput['sellingAsset']): Asset {
  if (input instanceof Asset) {
    return input;
  }
  if (typeof input === 'string') {
    if (input.toUpperCase() === 'XLM' || input.toLowerCase() === 'native') {
      return Asset.native();
    }
    if (input.includes(':')) {
      // `includes(':')` guarantees split() yields at least two parts.
      const [code, issuer] = input.split(':') as [string, string];
      return new Asset(code, issuer);
    }
    // Bare asset code without issuer - this is ambiguous on Stellar
    // since multiple issuers can use the same asset code.
    throw new Error(
      `Asset code "${input}" requires an issuer. Use "${input}:ISSUER" format or provide an issuer in the object form.`
    );
  }
  if (input.code.toUpperCase() === 'XLM' || !input.issuer) {
    return Asset.native();
  }
  return new Asset(input.code, input.issuer);
}

// ─── Tool Class ───────────────────────────────────────────────────────────────

export class OfferBookTool {
  /**
   * Query Horizon orderbook endpoint and return bids, asks, and derived spread.
   */
  async execute(rawInput: unknown): Promise<OfferBookResult> {
    const input = OfferBookInputSchema.parse(rawInput);

    const selling = resolveAsset(input.sellingAsset);
    const buying = resolveAsset(input.buyingAsset);

    log.info(
      {
        selling: selling.isNative() ? 'native' : `${selling.getCode()}:${selling.getIssuer()}`,
        buying: buying.isNative() ? 'native' : `${buying.getCode()}:${buying.getIssuer()}`,
        limit: input.limit,
      },
      'Querying Stellar DEX order book'
    );

    let builder = horizonServer.orderbook(selling, buying);
    if (input.limit !== undefined) {
      builder = builder.limit(input.limit);
    }

    const response = await withBackoffGuard(() =>
      withRetry(() => builder.call(), config.MAX_RETRIES, config.RETRY_DELAY_MS)
    );

    const bids: PriceLevel[] = response.bids ?? [];
    const asks: PriceLevel[] = response.asks ?? [];

    let spread = '0';
    const topBid = bids[0];
    const topAsk = asks[0];
    if (topBid && topAsk) {
      const bestBid = parseFloat(topBid.price);
      const bestAsk = parseFloat(topAsk.price);
      const diff = bestAsk - bestBid;
      spread = diff.toFixed(7);
    }

    log.info({ bidCount: bids.length, askCount: asks.length, spread }, 'Order book query complete');

    return {
      bids,
      asks,
      spread,
    };
  }
}
