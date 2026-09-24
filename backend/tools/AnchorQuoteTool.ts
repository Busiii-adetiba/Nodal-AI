/**
 * backend/tools/AnchorQuoteTool.ts
 * Fetch SEP-0038 firm / indicative quotes from Stellar anchors.
 */

import axios from 'axios';
import { z } from 'zod';
import { config } from '../config';
import { withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';

export const AnchorQuoteInputSchema = z
  .object({
    anchorQuoteUrl: z.string().min(1, 'Anchor quote URL is required'),
    sellAsset: z.string().min(1, 'sellAsset is required'),
    buyAsset: z.string().min(1, 'buyAsset is required'),
    sellAmount: z.string().optional(),
    buyAmount: z.string().optional(),
    context: z.enum(['sep6', 'sep31']).optional(),
    jwtToken: z.string().optional(),
  })
  .refine((data) => data.sellAmount !== undefined || data.buyAmount !== undefined, {
    message: 'Either sellAmount or buyAmount must be provided',
  });

export type AnchorQuoteInput = z.infer<typeof AnchorQuoteInputSchema>;

export const AnchorQuoteFeeSchema = z.object({
  total: z.string().optional(),
  asset: z.string().optional(),
  details: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        amount: z.string(),
      })
    )
    .optional(),
});

export const AnchorQuoteResponseSchema = z
  .object({
    price: z.string(),
    total_price: z.string().optional(),
    expires_at: z.string().optional(),
    sell_amount: z.string().optional(),
    buy_amount: z.string().optional(),
    fee: AnchorQuoteFeeSchema.optional(),
  })
  .passthrough();

export type AnchorQuoteResponse = z.infer<typeof AnchorQuoteResponseSchema>;

export class AnchorQuoteTool {
  async fetchQuote(rawInput: unknown): Promise<AnchorQuoteResponse> {
    const input = AnchorQuoteInputSchema.parse(rawInput);

    const baseUrl = input.anchorQuoteUrl.replace(/\/+$/, '');
    const url = baseUrl.endsWith('/price') ? baseUrl : `${baseUrl}/price`;

    const params: Record<string, string> = {
      sell_asset: input.sellAsset,
      buy_asset: input.buyAsset,
    };

    if (input.sellAmount !== undefined) {
      params.sell_amount = input.sellAmount;
    }
    if (input.buyAmount !== undefined) {
      params.buy_amount = input.buyAmount;
    }
    if (input.context !== undefined) {
      params.context = input.context;
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (input.jwtToken) {
      headers.Authorization = `Bearer ${input.jwtToken}`;
    }

    const response = await withBackoffGuard(() =>
      withRetry(
        () =>
          axios.get(url, {
            params,
            headers,
            timeout: 10_000,
          }),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );

    return AnchorQuoteResponseSchema.parse(response.data);
  }

  async execute(rawInput: unknown): Promise<AnchorQuoteResponse> {
    return this.fetchQuote(rawInput);
  }
}
