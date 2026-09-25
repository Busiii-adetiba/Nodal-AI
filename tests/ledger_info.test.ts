/**
 * tests/ledger_info.test.ts
 * Tests for LedgerInfoTool and ledger_info task type (#551).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LedgerInfoTool, LedgerInfoInputSchema } from '../backend/tools/LedgerInfoTool';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  sorobanServer: {
    getLatestLedger: vi.fn(),
  },
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../backend/network', () => ({
  withBackoffGuard: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../backend/config', () => ({
  config: {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
  },
}));

describe('LedgerInfoInputSchema', () => {
  it('defaults to forceRefresh: false when omitted or empty', () => {
    expect(LedgerInfoInputSchema.parse(undefined)).toEqual({ forceRefresh: false });
    expect(LedgerInfoInputSchema.parse({})).toEqual({ forceRefresh: false });
  });

  it('accepts explicit forceRefresh boolean', () => {
    expect(LedgerInfoInputSchema.parse({ forceRefresh: true })).toEqual({ forceRefresh: true });
    expect(LedgerInfoInputSchema.parse({ forceRefresh: false })).toEqual({ forceRefresh: false });
  });

  it('rejects non-boolean forceRefresh values', () => {
    expect(() => LedgerInfoInputSchema.parse({ forceRefresh: 'yes' as any })).toThrow();
  });
});

describe('LedgerInfoTool', () => {
  let tool: LedgerInfoTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new LedgerInfoTool(6_000);
  });

  it('fetches current ledger info from Soroban RPC', async () => {
    vi.mocked(rpcClient.sorobanServer.getLatestLedger).mockResolvedValue({
      sequence: 123456,
      protocolVersion: 20,
    } as any);

    const result = await tool.execute();

    expect(result).toEqual({
      sequence: 123456,
      protocolVersion: 20,
    });
    expect(rpcClient.sorobanServer.getLatestLedger).toHaveBeenCalledTimes(1);
  });

  it('coerces string sequences and protocol versions to numbers', async () => {
    vi.mocked(rpcClient.sorobanServer.getLatestLedger).mockResolvedValue({
      sequence: '987654',
      protocolVersion: '21',
    } as any);

    const result = await tool.execute();

    expect(result).toEqual({
      sequence: 987654,
      protocolVersion: 21,
    });
  });

  it('serves results from cache on subsequent calls within TTL', async () => {
    vi.mocked(rpcClient.sorobanServer.getLatestLedger).mockResolvedValue({
      sequence: 100,
      protocolVersion: 20,
    } as any);

    const first = await tool.execute();
    const second = await tool.execute();

    expect(first).toEqual({ sequence: 100, protocolVersion: 20 });
    expect(second).toEqual({ sequence: 100, protocolVersion: 20 });
    expect(rpcClient.sorobanServer.getLatestLedger).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when forceRefresh is true', async () => {
    vi.mocked(rpcClient.sorobanServer.getLatestLedger)
      .mockResolvedValueOnce({ sequence: 100, protocolVersion: 20 } as any)
      .mockResolvedValueOnce({ sequence: 101, protocolVersion: 20 } as any);

    const first = await tool.execute();
    const second = await tool.execute({ forceRefresh: true });

    expect(first.sequence).toBe(100);
    expect(second.sequence).toBe(101);
    expect(rpcClient.sorobanServer.getLatestLedger).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache when clearCache() is called', async () => {
    vi.mocked(rpcClient.sorobanServer.getLatestLedger)
      .mockResolvedValueOnce({ sequence: 200, protocolVersion: 20 } as any)
      .mockResolvedValueOnce({ sequence: 201, protocolVersion: 20 } as any);

    const first = await tool.execute();
    tool.clearCache();
    const second = await tool.execute();

    expect(first.sequence).toBe(200);
    expect(second.sequence).toBe(201);
    expect(rpcClient.sorobanServer.getLatestLedger).toHaveBeenCalledTimes(2);
  });

  it('refetches from RPC when cache expires after TTL', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(rpcClient.sorobanServer.getLatestLedger)
        .mockResolvedValueOnce({ sequence: 300, protocolVersion: 20 } as any)
        .mockResolvedValueOnce({ sequence: 301, protocolVersion: 20 } as any);

      const first = await tool.execute();
      expect(first.sequence).toBe(300);

      vi.advanceTimersByTime(6001);

      const second = await tool.execute();
      expect(second.sequence).toBe(301);
      expect(rpcClient.sorobanServer.getLatestLedger).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes retry configuration to withRetry', async () => {
    vi.mocked(rpcClient.sorobanServer.getLatestLedger).mockResolvedValue({
      sequence: 123456,
      protocolVersion: 20,
    } as any);

    await tool.execute();

    expect(rpcClient.withRetry).toHaveBeenCalledWith(expect.any(Function), 3, 100);
  });

  it('propagates RPC error when call fails', async () => {
    vi.mocked(rpcClient.sorobanServer.getLatestLedger).mockRejectedValue(
      new Error('Soroban RPC unavailable')
    );

    await expect(tool.execute()).rejects.toThrow('Soroban RPC unavailable');
  });
});
