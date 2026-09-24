/**
 * backend/tools/FriendBotTool.ts
 * Tool for programmatically funding testnet / futurenet accounts via Friendbot.
 */

import { z } from 'zod';
import { config } from '../config';
import { ConfigError } from '../errors';
import { createLogger } from '../utils/logger';
import { withRetry, withBackoffGuard } from '../rpc_client';

const log = createLogger('friendbot-tool');

// ─── Input Schema ─────────────────────────────────────────────────────────────

export const FriendBotInputSchema = z.object({
  /** 56-character Stellar public key (G… encoding). */
  publicKey: z
    .string()
    .length(56, 'Must be a 56-character Stellar public key (G…)')
    .refine((val) => val.startsWith('G'), { message: 'Public key must start with G' }),
});

export type FriendBotInput = z.infer<typeof FriendBotInputSchema>;

// ─── Response Schema ────────────────────────────────────────────────────────────

export const FriendBotResponseSchema = z
  .object({
    hash: z.string().optional(),
    txHash: z.string().optional(),
  })
  .passthrough();

export type FriendBotResponse = z.infer<typeof FriendBotResponseSchema>;

export interface FriendBotResult {
  funded: boolean;
  txHash?: string;
}

// ─── Tool Class ───────────────────────────────────────────────────────────────

export class FriendBotTool {
  /**
   * Request Friendbot test account funding.
   * Throws ConfigError if invoked on mainnet.
   */
  async execute(rawInput: unknown): Promise<FriendBotResult> {
    const input = FriendBotInputSchema.parse(rawInput);

    if (config.STELLAR_NETWORK === 'mainnet') {
      throw new ConfigError('Friendbot funding is not available on mainnet');
    }

    log.info(
      { publicKey: input.publicKey, network: config.STELLAR_NETWORK },
      'Requesting Friendbot account funding'
    );

    const baseUrl =
      config.STELLAR_NETWORK === 'futurenet'
        ? 'https://friendbot-futurenet.stellar.org'
        : 'https://friendbot.stellar.org';

    const url = `${baseUrl}?addr=${encodeURIComponent(input.publicKey)}`;

    const response = await withBackoffGuard(() =>
      withRetry(async () => {
        const res = await fetch(url);
        if (!res.ok) {
          const errorText = await res.text().catch(() => '');
          throw new Error(`Friendbot request failed with status ${res.status}: ${errorText}`);
        }
        return res;
      })
    );

    const json = FriendBotResponseSchema.parse(await response.json());
    const txHash: string | undefined = json.hash ?? json.txHash;

    log.info({ publicKey: input.publicKey, txHash }, 'Friendbot account funding succeeded');

    return {
      funded: true,
      ...(txHash ? { txHash } : {}),
    };
  }
}
