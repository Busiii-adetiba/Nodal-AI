/**
 * tests/friendbot.test.ts
 * Tests for FriendBotTool (#550, #593)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FriendBotTool } from '../backend/tools/FriendBotTool';
import { ConfigError } from '../backend/errors';

const { getNetwork, setNetwork } = vi.hoisted(() => {
  let network = 'testnet';
  return {
    getNetwork: () => network,
    setNetwork: (n: string) => {
      network = n;
    },
  };
});

vi.mock('../backend/config', () => ({
  config: {
    get STELLAR_NETWORK() {
      return getNetwork();
    },
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    MAX_RETRIES: 2,
    RETRY_DELAY_MS: 1,
  },
}));

vi.mock('../backend/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const VALID_PUBLIC_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('FriendBotTool', () => {
  let tool: FriendBotTool;

  beforeEach(() => {
    vi.clearAllMocks();
    setNetwork('testnet');
    tool = new FriendBotTool();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('funds testnet account successfully and returns txHash from hash field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hash: 'tx_hash_123', ledger: 100 }),
    } as Response);

    const result = await tool.execute({ publicKey: VALID_PUBLIC_KEY });

    expect(result).toEqual({ funded: true, txHash: 'tx_hash_123' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      `https://friendbot.stellar.org?addr=${encodeURIComponent(VALID_PUBLIC_KEY)}`
    );
  });

  it('funds account successfully and returns txHash from txHash field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ txHash: 'tx_hash_456' }),
    } as Response);

    const result = await tool.execute({ publicKey: VALID_PUBLIC_KEY });

    expect(result).toEqual({ funded: true, txHash: 'tx_hash_456' });
  });

  it('funds account successfully without txHash when response has neither hash nor txHash', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await tool.execute({ publicKey: VALID_PUBLIC_KEY });

    expect(result).toEqual({ funded: true });
  });

  it('uses futurenet friendbot URL when network is futurenet', async () => {
    setNetwork('futurenet');
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hash: 'futurenet_hash' }),
    } as Response);

    const result = await tool.execute({ publicKey: VALID_PUBLIC_KEY });

    expect(result).toEqual({ funded: true, txHash: 'futurenet_hash' });
    expect(fetch).toHaveBeenCalledWith(
      `https://friendbot-futurenet.stellar.org?addr=${encodeURIComponent(VALID_PUBLIC_KEY)}`
    );
  });

  it('throws ConfigError when invoked on mainnet', async () => {
    setNetwork('mainnet');

    await expect(tool.execute({ publicKey: VALID_PUBLIC_KEY })).rejects.toThrow(ConfigError);
    await expect(tool.execute({ publicKey: VALID_PUBLIC_KEY })).rejects.toThrow(
      'Friendbot funding is not available on mainnet'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates friendbot response against Zod schema and rejects invalid response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => 'not a valid json object',
    } as Response);

    await expect(tool.execute({ publicKey: VALID_PUBLIC_KEY })).rejects.toThrow();
  });

  it('rejects response when hash is not a string', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ hash: 12345 }),
    } as Response);

    await expect(tool.execute({ publicKey: VALID_PUBLIC_KEY })).rejects.toThrow();
  });

  it('retries on failure via withRetry and succeeds', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service Temporarily Unavailable',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ hash: 'retry_success_hash' }),
      } as Response);

    const result = await tool.execute({ publicKey: VALID_PUBLIC_KEY });

    expect(result).toEqual({ funded: true, txHash: 'retry_success_hash' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('propagates error when Friendbot request fails after retries exhausted', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response);

    await expect(tool.execute({ publicKey: VALID_PUBLIC_KEY })).rejects.toThrow(
      'Friendbot request failed with status 500: Internal Server Error'
    );
  });

  it('rejects invalid public key input', async () => {
    await expect(tool.execute({ publicKey: 'invalid_key' })).rejects.toThrow();
    await expect(
      tool.execute({ publicKey: 'SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73' })
    ).rejects.toThrow(/must start with G/i);
  });
});
