/**
 * backend/tools/StellarTomlTool.ts
 * Tool for fetching, parsing SEP-0001 stellar.toml files with caching.
 */

import axios from 'axios';
import toml from 'toml';
import { z } from 'zod';
import { config } from '../config';
import { withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';

export const StellarTomlInputSchema = z.object({
  domain: z.string().min(1, 'Domain is required'),
});

export type StellarTomlInput = z.infer<typeof StellarTomlInputSchema>;

export interface StellarTomlFields {
  ACCOUNTS?: string[];
  CURRENCIES?: Array<Record<string, any>>;
  DOCUMENTATION?: Record<string, any>;
  PRINCIPALS?: Array<Record<string, any>>;
  [key: string]: any;
}

interface CacheEntry {
  data: StellarTomlFields;
  expiresAt: number;
}

export class StellarTomlTool {
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;

  constructor(ttlMs: number = config.TOML_CACHE_TTL_MS ?? 300_000) {
    this.cacheTtlMs = ttlMs;
  }

  async fetchToml(rawInput: unknown): Promise<StellarTomlFields> {
    const input = StellarTomlInputSchema.parse(rawInput);
    const domain = input.domain.toLowerCase().trim();
    const now = Date.now();

    const cached = this.cache.get(domain);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const url = `https://${domain}/.well-known/stellar.toml`;
    const response = await withBackoffGuard(() =>
      withRetry(
        () => axios.get(url, { responseType: 'text', timeout: 10_000 }),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );
    const parsed = toml.parse(response.data);

    const result: StellarTomlFields = {
      ACCOUNTS: parsed.ACCOUNTS,
      CURRENCIES: parsed.CURRENCIES,
      DOCUMENTATION: parsed.DOCUMENTATION,
      PRINCIPALS: parsed.PRINCIPALS,
      ...parsed,
    };

    this.cache.set(domain, {
      data: result,
      expiresAt: now + this.cacheTtlMs,
    });

    return result;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
