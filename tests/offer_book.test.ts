/**
 * tests/offer_book.test.ts
 * Tests for OfferBookTool, asset resolution, and spread calculation (#553).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Asset } from '@stellar/stellar-sdk';
import { OfferBookTool, OfferBookInputSchema, resolveAsset } from '../backend/tools/OfferBookTool';
import * as rpcClient from '../backend/rpc_client';

const mockOrderbookCall = vi.fn();
const mockLimit = vi.fn();

vi.mock('../backend/rpc_client', () => ({
  horizonServer: {
    orderbook: vi.fn(),
  },
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../backend/network', () => ({
  withBackoffGuard: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../backend/config', () => ({
  config: {
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
  },
}));

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('resolveAsset helper', () => {
  it('returns native asset for Asset.native() instance', () => {
    const asset = Asset.native();
    expect(resolveAsset(asset).isNative()).toBe(true);
  });

  it('returns native asset for "XLM" or "native" string', () => {
    expect(resolveAsset('XLM').isNative()).toBe(true);
    expect(resolveAsset('xlm').isNative()).toBe(true);
    expect(resolveAsset('native').isNative()).toBe(true);
  });

  it('resolves "CODE:ISSUER" string', () => {
    const asset = resolveAsset(`USDC:${ISSUER}`);
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(ISSUER);
  });

  it('uses default X402_ASSET_ISSUER when code-only string provided', () => {
    const asset = resolveAsset('USDC');
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(ISSUER);
  });

  it('resolves asset descriptor object', () => {
    expect(resolveAsset({ code: 'XLM' }).isNative()).toBe(true);
    const custom = resolveAsset({ code: 'BTC', issuer: ISSUER });
    expect(custom.getCode()).toBe('BTC');
    expect(custom.getIssuer()).toBe(ISSUER);
  });

  it('returns custom credit asset for Asset instance', () => {
    const custom = new Asset('USDC', ISSUER);
    const resolved = resolveAsset(custom);
    expect(resolved.getCode()).toBe('USDC');
    expect(resolved.getIssuer()).toBe(ISSUER);
    expect(resolved.isNative()).toBe(false);
  });
});

describe('OfferBookInputSchema', () => {
  it('accepts valid asset combinations and limit', () => {
    const parsed = OfferBookInputSchema.parse({
      sellingAsset: 'XLM',
      buyingAsset: `USDC:${ISSUER}`,
      limit: 50,
    });
    expect(parsed.limit).toBe(50);
  });

  it('rejects invalid limit values', () => {
    expect(() =>
      OfferBookInputSchema.parse({
        sellingAsset: 'XLM',
        buyingAsset: 'USDC',
        limit: 0,
      })
    ).toThrow();

    expect(() =>
      OfferBookInputSchema.parse({
        sellingAsset: 'XLM',
        buyingAsset: 'USDC',
        limit: 201,
      })
    ).toThrow();
  });
});

describe('OfferBookTool', () => {
  let tool: OfferBookTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new OfferBookTool();

    mockLimit.mockReturnValue({ call: mockOrderbookCall });
    vi.mocked(rpcClient.horizonServer.orderbook).mockReturnValue({
      call: mockOrderbookCall,
      limit: mockLimit,
    } as any);
  });

  it('queries orderbook and calculates spread correctly', async () => {
    mockOrderbookCall.mockResolvedValue({
      bids: [
        { price: '0.1200000', price_r: { n: 12, d: 100 }, amount: '1000' },
        { price: '0.1190000', price_r: { n: 119, d: 1000 }, amount: '2000' },
      ],
      asks: [
        { price: '0.1250000', price_r: { n: 125, d: 1000 }, amount: '500' },
        { price: '0.1260000', price_r: { n: 126, d: 1000 }, amount: '1500' },
      ],
    });

    const result = await tool.execute({
      sellingAsset: 'XLM',
      buyingAsset: `USDC:${ISSUER}`,
    });

    expect(result.bids).toHaveLength(2);
    expect(result.asks).toHaveLength(2);
    // bestAsk (0.125) - bestBid (0.120) = 0.0050000
    expect(result.spread).toBe('0.0050000');
    expect(rpcClient.horizonServer.orderbook).toHaveBeenCalledTimes(1);
  });

  it('sets spread to "0" when bids or asks are empty', async () => {
    mockOrderbookCall.mockResolvedValue({
      bids: [],
      asks: [{ price: '0.1250000', price_r: { n: 125, d: 1000 }, amount: '500' }],
    });

    const result = await tool.execute({
      sellingAsset: 'XLM',
      buyingAsset: `USDC:${ISSUER}`,
    });

    expect(result.spread).toBe('0');
  });

  it('sets spread to "0" when asks are empty but bids are present', async () => {
    mockOrderbookCall.mockResolvedValue({
      bids: [{ price: '0.1200000', price_r: { n: 12, d: 100 }, amount: '1000' }],
      asks: [],
    });

    const result = await tool.execute({
      sellingAsset: 'XLM',
      buyingAsset: `USDC:${ISSUER}`,
    });

    expect(result.spread).toBe('0');
  });

  it('sets spread to "0" when both bids and asks are empty', async () => {
    mockOrderbookCall.mockResolvedValue({
      bids: [],
      asks: [],
    });

    const result = await tool.execute({
      sellingAsset: 'XLM',
      buyingAsset: `USDC:${ISSUER}`,
    });

    expect(result.spread).toBe('0');
  });

  it('applies limit when specified', async () => {
    mockOrderbookCall.mockResolvedValue({
      bids: [],
      asks: [],
    });

    await tool.execute({
      sellingAsset: 'XLM',
      buyingAsset: `USDC:${ISSUER}`,
      limit: 10,
    });

    expect(mockLimit).toHaveBeenCalledWith(10);
    expect(mockOrderbookCall).toHaveBeenCalledTimes(1);
  });

  it('propagates Horizon orderbook error', async () => {
    mockOrderbookCall.mockRejectedValue(new Error('Horizon orderbook error'));

    await expect(
      tool.execute({
        sellingAsset: 'XLM',
        buyingAsset: `USDC:${ISSUER}`,
      })
    ).rejects.toThrow('Horizon orderbook error');
  });
});
