/**
 * tests/contract_storage_watcher.test.ts
 * Tests for ContractStorageWatcherTool and watchContractStorage (#592).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import {
  ContractStorageWatcherTool,
  watchContractStorage,
  normalizeLedgerKey,
} from '../backend/tools/ContractStorageWatcherTool';
import * as rpcClient from '../backend/rpc_client';
import type { MockSorobanServer } from './fixtures/MockSorobanServer';

vi.mock('../backend/rpc_client', async () => {
  const { createMockSorobanServer } = await import('./fixtures/MockSorobanServer');
  return createMockSorobanServer();
});

const mockSorobanServer = rpcClient as unknown as MockSorobanServer;

vi.mock('../backend/config', () => ({
  config: {
    CONTRACT_EVENT_POLL_MS: 300,
  },
}));

vi.mock('../backend/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const VALID_CONTRACT = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';
const KEY_XDR = normalizeLedgerKey(VALID_CONTRACT, 'balance').toXDR('base64');

describe('normalizeLedgerKey', () => {
  it('returns instance as-is if already an xdr.LedgerKey', () => {
    const key = normalizeLedgerKey(VALID_CONTRACT, 'balance');
    const normalized = normalizeLedgerKey(VALID_CONTRACT, key);
    expect(normalized).toBe(key);
  });

  it('normalizes xdr.ScVal to xdr.LedgerKey.contractData', () => {
    const scVal = xdr.ScVal.scvSymbol('counter');
    const normalized = normalizeLedgerKey(VALID_CONTRACT, scVal);
    expect(normalized.switch()).toBe(xdr.LedgerEntryType.contractData());
    expect(normalized.contractData().key().sym().toString()).toBe('counter');
  });

  it('decodes base64-encoded LedgerKey string', () => {
    const original = normalizeLedgerKey(VALID_CONTRACT, 'balance');
    const base64 = original.toXDR('base64');
    const normalized = normalizeLedgerKey(VALID_CONTRACT, base64);
    expect(normalized.toXDR('base64')).toBe(base64);
  });

  it('decodes base64-encoded ScVal string', () => {
    const scVal = xdr.ScVal.scvSymbol('data_key');
    const base64 = scVal.toXDR('base64');
    const normalized = normalizeLedgerKey(VALID_CONTRACT, base64);
    expect(normalized.contractData().key().sym().toString()).toBe('data_key');
  });

  it('treats plain string as symbol ScVal fallback', () => {
    const normalized = normalizeLedgerKey(VALID_CONTRACT, 'user_status');
    expect(normalized.contractData().key().sym().toString()).toBe('user_status');
  });

  it('throws on unsupported key type', () => {
    expect(() => normalizeLedgerKey(VALID_CONTRACT, 12345 as any)).toThrow(
      'Unsupported key format'
    );
  });
});

describe('ContractStorageWatcherTool', () => {
  let watcher: ContractStorageWatcherTool | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSorobanServer.reset();
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    vi.useRealTimers();
  });

  describe('happy-path watch/poll cycle with MockSorobanServer fixture', () => {
    it('sets baseline state on first poll without emitting change', async () => {
      mockSorobanServer.setGetLedgerEntries({
        entries: [{ key: KEY_XDR, val: 'v1' }],
        latestLedger: 100,
      });

      const onChange = vi.fn();
      const onPoll = vi.fn();

      watcher = new ContractStorageWatcherTool({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
      });
      watcher.on('change', onChange);
      watcher.on('poll', onPoll);
      watcher.on('error', () => {});

      await vi.advanceTimersByTimeAsync(10);

      expect(onChange).not.toHaveBeenCalled();
      expect(onPoll).toHaveBeenCalledWith(1, [{ key: KEY_XDR, val: 'v1' }]);
      expect(watcher.getPollCount()).toBe(1);
      expect(watcher.isWatching()).toBe(true);
    });

    it('emits a change event when a watched key value changes between polls', async () => {
      mockSorobanServer.sorobanServer.getLedgerEntries
        .mockResolvedValueOnce({
          entries: [{ key: KEY_XDR, val: 'v1' }],
          latestLedger: 100,
        } as any)
        .mockResolvedValue({
          entries: [{ key: KEY_XDR, val: 'v2' }],
          latestLedger: 101,
        } as any);

      const onChange = vi.fn();
      watcher = new ContractStorageWatcherTool({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
      });
      watcher.on('change', onChange);
      watcher.on('error', () => {});

      await vi.advanceTimersByTimeAsync(310);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          keyXdr: KEY_XDR,
          oldValue: 'v1',
          newValue: 'v2',
          ledger: 101,
        })
      );
      expect(watcher.getPollCount()).toBe(2);
    });

    it('emits a change event with newValue undefined when a watched key disappears', async () => {
      mockSorobanServer.sorobanServer.getLedgerEntries
        .mockResolvedValueOnce({
          entries: [{ key: KEY_XDR, val: 'v1' }],
          latestLedger: 100,
        } as any)
        .mockResolvedValue({
          entries: [],
          latestLedger: 101,
        } as any);

      const onChange = vi.fn();
      watcher = new ContractStorageWatcherTool({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
      });
      watcher.on('change', onChange);
      watcher.on('error', () => {});

      await vi.advanceTimersByTimeAsync(310);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          keyXdr: KEY_XDR,
          oldValue: 'v1',
          newValue: undefined,
          ledger: 101,
        })
      );
    });

    it('respects pre-seeded initialState in options as baseline without waiting', async () => {
      mockSorobanServer.setGetLedgerEntries({
        entries: [{ key: KEY_XDR, val: 'v2' }],
        latestLedger: 100,
      });

      const onChange = vi.fn();
      watcher = new ContractStorageWatcherTool({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
        initialState: { [KEY_XDR]: 'v1' },
      });
      watcher.on('change', onChange);
      watcher.on('error', () => {});

      await vi.advanceTimersByTimeAsync(10);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          keyXdr: KEY_XDR,
          oldValue: 'v1',
          newValue: 'v2',
        })
      );
    });
  });

  describe('error/reconnect scenario', () => {
    it('handles transient error, emits error event, logs, and resumes on next poll', async () => {
      const { logger } = await import('../backend/logger');
      const onError = vi.fn();
      const onChange = vi.fn();

      mockSorobanServer.sorobanServer.getLedgerEntries
        .mockRejectedValueOnce(new Error('Connection reset by peer'))
        .mockResolvedValueOnce({
          entries: [{ key: KEY_XDR, val: 'v1' }],
          latestLedger: 100,
        } as any)
        .mockResolvedValue({
          entries: [{ key: KEY_XDR, val: 'v2' }],
          latestLedger: 101,
        } as any);

      watcher = new ContractStorageWatcherTool({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
      });
      watcher.on('error', onError);
      watcher.on('change', onChange);

      // Poll 1 (immediate at 0ms): fails with connection error
      await vi.advanceTimersByTimeAsync(10);
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(logger.error).toHaveBeenCalled();
      expect(watcher.isWatching()).toBe(true);

      // Poll 2 (at 300ms): reconnects and establishes baseline v1
      await vi.advanceTimersByTimeAsync(300);
      expect(watcher.getPollCount()).toBe(2);
      expect(onChange).not.toHaveBeenCalled();

      // Poll 3 (at 600ms): sees state transition to v2
      await vi.advanceTimersByTimeAsync(300);
      expect(watcher.getPollCount()).toBe(3);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          keyXdr: KEY_XDR,
          oldValue: 'v1',
          newValue: 'v2',
        })
      );
    });
  });

  describe('stop() and cleanup path', () => {
    it('stops polling when stop() is called and cancels scheduled timeout', async () => {
      mockSorobanServer.setGetLedgerEntries({
        entries: [{ key: KEY_XDR, val: 'v1' }],
        latestLedger: 100,
      });

      watcher = new ContractStorageWatcherTool({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
      });
      watcher.on('error', () => {});

      await vi.advanceTimersByTimeAsync(310);
      const callsBeforeStop = mockSorobanServer.sorobanServer.getLedgerEntries.mock.calls.length;

      watcher.stop();
      expect(watcher.isWatching()).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockSorobanServer.sorobanServer.getLedgerEntries.mock.calls.length).toBe(
        callsBeforeStop
      );
    });

    it('stop() is idempotent — calling it multiple times is safe', async () => {
      mockSorobanServer.setGetLedgerEntries({
        entries: [{ key: KEY_XDR, val: 'v1' }],
        latestLedger: 100,
      });

      watcher = new ContractStorageWatcherTool({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
      });
      watcher.on('error', () => {});

      await vi.advanceTimersByTimeAsync(10);

      expect(() => {
        watcher!.stop();
        watcher!.stop();
      }).not.toThrow();
      expect(watcher.isWatching()).toBe(false);
    });

    it('stops automatically and emits done once maxPolls is reached', async () => {
      mockSorobanServer.setGetLedgerEntries({
        entries: [{ key: KEY_XDR, val: 'v1' }],
        latestLedger: 100,
      });

      const onDone = vi.fn();
      watcher = new ContractStorageWatcherTool({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
        maxPolls: 2,
      });
      watcher.on('done', onDone);
      watcher.on('error', () => {});

      await vi.advanceTimersByTimeAsync(310);

      expect(onDone).toHaveBeenCalledWith({ totalPolls: 2 });
      expect(watcher.isWatching()).toBe(false);
    });
  });

  describe('watchContractStorage functional interface', () => {
    it('returns a callable handle that forwards events and supports stop', async () => {
      mockSorobanServer.sorobanServer.getLedgerEntries
        .mockResolvedValueOnce({
          entries: [{ key: KEY_XDR, val: 'v1' }],
          latestLedger: 100,
        } as any)
        .mockResolvedValue({
          entries: [{ key: KEY_XDR, val: 'v2' }],
          latestLedger: 101,
        } as any);

      const onChange = vi.fn();
      const handle = watchContractStorage({
        contractId: VALID_CONTRACT,
        keys: ['balance'],
        pollIntervalMs: 300,
      });
      handle.on('change', onChange);
      handle.on('error', () => {});

      expect(handle.isWatching()).toBe(true);
      expect(typeof handle.stop).toBe('function');

      await vi.advanceTimersByTimeAsync(310);

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          keyXdr: KEY_XDR,
          oldValue: 'v1',
          newValue: 'v2',
        })
      );

      // Calling the handle directly as a function stops it
      handle();
      expect(handle.isWatching()).toBe(false);
    });
  });
});
