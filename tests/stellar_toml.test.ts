/**
 * tests/stellar_toml.test.ts
 * Unit tests for StellarTomlTool with mocked HTTPS responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { StellarTomlTool } from '../backend/tools/StellarTomlTool';

vi.mock('axios');

vi.mock('../backend/config', () => ({
  config: {
    TOML_CACHE_TTL_MS: 300_000,
  },
}));

describe('StellarTomlTool', () => {
  let tool: StellarTomlTool;

  const mockTomlContent = `
VERSION = "2.0.0"

ACCOUNTS = [
  "GABCD1234567890ACCOUNT1",
  "GABCD1234567890ACCOUNT2"
]

[DOCUMENTATION]
ORG_NAME = "Example Org"
ORG_URL = "https://example.com"

[[CURRENCIES]]
CODE = "USDC"
ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

[[PRINCIPALS]]
NAME = "Alice"
EMAIL = "alice@example.com"
`;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new StellarTomlTool(300_000);
  });

  it('fetches and parses stellar.toml successfully with typed fields', async () => {
    (axios.get as any).mockResolvedValue({
      data: mockTomlContent,
    });

    const res = await tool.fetchToml({ domain: 'example.com' });

    expect(axios.get).toHaveBeenCalledWith('https://example.com/.well-known/stellar.toml', {
      responseType: 'text',
      timeout: 10000,
    });

    expect(res.DOCUMENTATION?.ORG_NAME).toBe('Example Org');
    expect(res.CURRENCIES).toHaveLength(1);
    expect(res.CURRENCIES?.[0]!.CODE).toBe('USDC');
    expect(res.PRINCIPALS?.[0]!.NAME).toBe('Alice');
    expect(res.ACCOUNTS).toEqual(['GABCD1234567890ACCOUNT1', 'GABCD1234567890ACCOUNT2']);
  });

  it('caches results for the configured TTL', async () => {
    (axios.get as any).mockResolvedValue({
      data: mockTomlContent,
    });

    const res1 = await tool.fetchToml({ domain: 'example.com' });
    const res2 = await tool.fetchToml({ domain: 'example.com' });

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(res1).toBe(res2);
  });

  it('fetches again after cache expiration or clearCache()', async () => {
    (axios.get as any).mockResolvedValue({
      data: mockTomlContent,
    });

    // Tool with 10ms TTL
    const shortTtlTool = new StellarTomlTool(10);
    await shortTtlTool.fetchToml({ domain: 'example.com' });

    // Wait 20ms to expire
    await new Promise((r) => setTimeout(r, 20));

    await shortTtlTool.fetchToml({ domain: 'example.com' });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('throws ZodError on invalid input domain', async () => {
    await expect(tool.fetchToml({ domain: '' })).rejects.toThrow();
  });

  // --- SEP-1 response validation (Issue #573) -----------------------------

  it('rejects a stellar.toml whose ACCOUNTS is not a list of strings', async () => {
    // Previously this reached callers typed `any`, so `ACCOUNTS.map(...)`
    // downstream would throw somewhere far from the cause.
    (axios.get as any).mockResolvedValue({
      data: 'ACCOUNTS = "GABCD1234567890ACCOUNT1"\n',
    });

    await expect(tool.fetchToml({ domain: 'bad.example.com' })).rejects.toThrow();
  });

  it('rejects a CURRENCIES entry with a non-string code', async () => {
    (axios.get as any).mockResolvedValue({
      data: '[[CURRENCIES]]\ncode = 42\n',
    });

    await expect(tool.fetchToml({ domain: 'bad.example.com' })).rejects.toThrow();
  });

  it('rejects a currency status outside the SEP-1 enum', async () => {
    (axios.get as any).mockResolvedValue({
      data: '[[CURRENCIES]]\ncode = "USDC"\nstatus = "maybe"\n',
    });

    await expect(tool.fetchToml({ domain: 'bad.example.com' })).rejects.toThrow();
  });

  it('accepts a currency that only points at another toml', async () => {
    // Spec-compliant: a CURRENCIES entry may carry just `toml`, deferring the
    // real definition to a separate file. Requiring code/issuer would break
    // these anchors.
    (axios.get as any).mockResolvedValue({
      data: '[[CURRENCIES]]\ntoml = "https://example.com/USDC.toml"\n',
    });

    const res = await tool.fetchToml({ domain: 'example.com' });
    expect(res.CURRENCIES?.[0]?.toml).toBe('https://example.com/USDC.toml');
  });

  it('accepts a sparsely populated toml', async () => {
    // Anchors fill these in unevenly. A schema that required fields the caller
    // never reads would turn a partial file into a failed lookup.
    (axios.get as any).mockResolvedValue({ data: 'VERSION = "2.0.0"\n' });

    const res = await tool.fetchToml({ domain: 'sparse.example.com' });
    expect(res.VERSION).toBe('2.0.0');
    expect(res.CURRENCIES).toBeUndefined();
  });

  it('keeps fields the schema does not name', async () => {
    // `.passthrough()` — SEP-1 defines more than this tool names, and anchors
    // add their own. Validating must not silently discard them.
    (axios.get as any).mockResolvedValue({
      data: 'VERSION = "2.0.0"\nCUSTOM_ANCHOR_FIELD = "keep me"\n',
    });

    const res = await tool.fetchToml({ domain: 'example.com' });
    expect(res['CUSTOM_ANCHOR_FIELD']).toBe('keep me');
  });

  it('parses the well-known SEP-1 tables into typed fields', async () => {
    (axios.get as any).mockResolvedValue({
      data: `
VERSION = "2.0.0"
SIGNING_KEY = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

[DOCUMENTATION]
ORG_NAME = "Example Org"

[[CURRENCIES]]
code = "USDC"
issuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
status = "live"
display_decimals = 2

[[PRINCIPALS]]
name = "Alice"
email = "alice@example.com"
`,
    });

    const res = await tool.fetchToml({ domain: 'typed.example.com' });

    expect(res.DOCUMENTATION?.ORG_NAME).toBe('Example Org');
    expect(res.CURRENCIES?.[0]?.code).toBe('USDC');
    expect(res.CURRENCIES?.[0]?.status).toBe('live');
    expect(res.CURRENCIES?.[0]?.display_decimals).toBe(2);
    expect(res.PRINCIPALS?.[0]?.name).toBe('Alice');
  });
});
