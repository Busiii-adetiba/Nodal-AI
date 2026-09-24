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

/**
 * SEP-1 `[DOCUMENTATION]` table.
 *
 * Every field is optional: SEP-1 marks the whole table as optional and anchors
 * populate it unevenly in practice. `.passthrough()` keeps fields the spec
 * defines but this tool does not name, so validating does not silently discard
 * data a caller may be reading.
 */
export const StellarTomlDocumentationSchema = z
  .object({
    ORG_NAME: z.string().optional(),
    ORG_DBA: z.string().optional(),
    ORG_URL: z.string().optional(),
    ORG_LOGO: z.string().optional(),
    ORG_DESCRIPTION: z.string().optional(),
    ORG_PHYSICAL_ADDRESS: z.string().optional(),
    ORG_OFFICIAL_EMAIL: z.string().optional(),
    ORG_SUPPORT_EMAIL: z.string().optional(),
    ORG_TWITTER: z.string().optional(),
    ORG_GITHUB: z.string().optional(),
  })
  .passthrough();

/**
 * SEP-1 `[[CURRENCIES]]` entry.
 *
 * `code` and `issuer` are the fields that identify an asset, but they are not
 * required here. A currency entry may instead carry only `toml` — a pointer to
 * a separate file holding the real definition — and rejecting those would make
 * the tool fail on anchors that are entirely spec-compliant.
 */
export const StellarTomlCurrencySchema = z
  .object({
    code: z.string().optional(),
    code_template: z.string().optional(),
    issuer: z.string().optional(),
    status: z.enum(['live', 'dead', 'test', 'private']).optional(),
    display_decimals: z.number().int().min(0).max(7).optional(),
    name: z.string().optional(),
    desc: z.string().optional(),
    image: z.string().optional(),
    fixed_number: z.number().optional(),
    max_number: z.number().optional(),
    is_unlimited: z.boolean().optional(),
    is_asset_anchored: z.boolean().optional(),
    anchor_asset_type: z.string().optional(),
    anchor_asset: z.string().optional(),
    /** Pointer to a separate stellar.toml holding this currency's definition. */
    toml: z.string().optional(),
  })
  .passthrough();

/** SEP-1 `[[PRINCIPALS]]` entry. */
export const StellarTomlPrincipalSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    keybase: z.string().optional(),
    twitter: z.string().optional(),
    github: z.string().optional(),
    id_photo_hash: z.string().optional(),
    verification_photo_hash: z.string().optional(),
  })
  .passthrough();

/**
 * The SEP-1 fields this tool surfaces.
 *
 * Nothing here is required. A stellar.toml is a document an arbitrary third
 * party publishes, and a schema that rejects a file for omitting a field the
 * caller never reads would turn "this anchor did not fill in ORG_URL" into a
 * hard failure of the whole lookup. Validation here is about *shape* — an
 * `ACCOUNTS` value that is a string rather than a list of strings is a real
 * problem, and previously reached callers typed as `any`.
 *
 * `.passthrough()` for the same reason as the nested tables: SEP-1 defines
 * more fields than this tool names, and anchors add their own.
 */
export const StellarTomlSchema = z
  .object({
    VERSION: z.string().optional(),
    NETWORK_PASSPHRASE: z.string().optional(),
    FEDERATION_SERVER: z.string().optional(),
    AUTH_SERVER: z.string().optional(),
    TRANSFER_SERVER: z.string().optional(),
    TRANSFER_SERVER_SEP0024: z.string().optional(),
    KYC_SERVER: z.string().optional(),
    WEB_AUTH_ENDPOINT: z.string().optional(),
    SIGNING_KEY: z.string().optional(),
    HORIZON_URL: z.string().optional(),
    ACCOUNTS: z.array(z.string()).optional(),
    URI_REQUEST_SIGNING_KEY: z.string().optional(),
    DIRECT_PAYMENT_SERVER: z.string().optional(),
    ANCHOR_QUOTE_SERVER: z.string().optional(),
    DOCUMENTATION: StellarTomlDocumentationSchema.optional(),
    CURRENCIES: z.array(StellarTomlCurrencySchema).optional(),
    PRINCIPALS: z.array(StellarTomlPrincipalSchema).optional(),
    VALIDATORS: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

/**
 * A validated stellar.toml.
 *
 * The index signature is `unknown` rather than `any` so a caller reaching for
 * a field outside the named set has to narrow it. That is the point of the
 * issue: `any` let a misspelled key or a wrongly-shaped anchor response flow
 * through the type system untouched.
 */
export type StellarTomlFields = z.infer<typeof StellarTomlSchema>;

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

    // Validate the third-party document before it reaches callers, matching
    // how StellarIdentityTool validates anchor responses. A malformed file
    // fails here with a ZodError naming the offending field, rather than
    // surfacing as an undefined property somewhere further downstream.
    const result = StellarTomlSchema.parse(parsed);

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
