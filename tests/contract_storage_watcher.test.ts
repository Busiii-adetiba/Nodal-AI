import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContractStorageWatcherTool, normalizeLedgerKey } from '../backend/tools/ContractStorageWatcherTool';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  sorobanServer: {
    getLedgerEntries: vi.fn(),
  },
}));

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

describe('ContractStorageWatcherTool', () => {
  let watcher: ContractStorageWatcherTool | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    vi.useRealTimers();
  });

  it('sets baseline state on first poll without emitting change', async () => {
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockResolvedValue({
      entries: [{ key: KEY_XDR, val: 'v1' }],
      latestLedger: 100,
    } as any);

    const onChange = vi.fn();
    watcher = new ContractStorageWatcherTool({
      contractId: VALID_CONTRACT,
      keys: ['balance'],
      pollIntervalMs: 300,
    });
    watcher.on('change', onChange);
    watcher.on('error', () => {});

    await vi.advanceTimersByTimeAsync(10);

    expect(onChange).not.toHaveBeenCalled();
    expect(watcher.getPollCount()).toBe(1);
  });

  it('emits a change event when a watched key value changes between polls', async () => {
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries)
      .mockResolvedValueOnce({ entries: [{ key: KEY_XDR, val: 'v1' }], latestLedger: 100 } as any)
      .mockResolvedValue({ entries: [{ key: KEY_XDR, val: 'v2' }], latestLedger: 101 } as any);

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
      expect.objectContaining({ keyXdr: KEY_XDR, oldValue: 'v1', newValue: 'v2' })
    );
  });

  it('emits a change event with newValue undefined when a watched key disappears', async () => {
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries)
      .mockResolvedValueOnce({ entries: [{ key: KEY_XDR, val: 'v1' }], latestLedger: 100 } as any)
      .mockResolvedValue({ entries: [], latestLedger: 101 } as any);

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
      expect.objectContaining({ keyXdr: KEY_XDR, oldValue: 'v1', newValue: undefined })
    );
  });

  it('stops polling after stop() is called', async () => {
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockResolvedValue({
      entries: [{ key: KEY_XDR, val: 'v1' }],
      latestLedger: 100,
    } as any);

    watcher = new ContractStorageWatcherTool({
      contractId: VALID_CONTRACT,
      keys: ['balance'],
      pollIntervalMs: 300,
    });
    watcher.on('error', () => {});

    await vi.advanceTimersByTimeAsync(310);
    const callsBeforeStop = vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mock.calls.length;

    watcher.stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mock.calls.length).toBe(
      callsBeforeStop
    );
    expect(watcher.isWatching()).toBe(false);
  });

  it('stops automatically and emits done once maxPolls is reached', async () => {
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockResolvedValue({
      entries: [{ key: KEY_XDR, val: 'v1' }],
      latestLedger: 100,
    } as any);

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

  it('logs an error and keeps polling when getLedgerEntries rejects', async () => {
    const { logger } = await import('../backend/logger');
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries)
      .mockRejectedValueOnce(new Error('RPC unavailable'))
      .mockResolvedValue({ entries: [{ key: KEY_XDR, val: 'v1' }], latestLedger: 100 } as any);

    watcher = new ContractStorageWatcherTool({
      contractId: VALID_CONTRACT,
      keys: ['balance'],
      pollIntervalMs: 300,
    });
    watcher.on('error', () => {});

    await vi.advanceTimersByTimeAsync(310);

    expect(logger.error).toHaveBeenCalled();
    expect(watcher.getPollCount()).toBeGreaterThanOrEqual(2);
  });

  it('stop() is idempotent — calling it twice does not throw', async () => {
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockResolvedValue({
      entries: [{ key: KEY_XDR, val: 'v1' }],
      latestLedger: 100,
    } as any);

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
  });
});
