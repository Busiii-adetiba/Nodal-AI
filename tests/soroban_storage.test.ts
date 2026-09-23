/**
 * tests/soroban_storage.test.ts
 * Tests for SorobanStorageTool, schema validation, and serialization (#554).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import {
  SorobanStorageTool,
  SorobanStorageInputSchema,
  toJsonSerializable,
} from '../backend/tools/SorobanStorageTool';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  sorobanServer: {
    getLedgerEntries: vi.fn(),
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

const VALID_CONTRACT = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';

describe('toJsonSerializable helper', () => {
  it('serializes BigInt to string', () => {
    expect(toJsonSerializable(BigInt(123456789012345))).toBe('123456789012345');
  });

  it('serializes Buffer and Uint8Array to hex string', () => {
    const buf = Buffer.from('hello');
    expect(toJsonSerializable(buf)).toBe(buf.toString('hex'));

    const uint8 = new Uint8Array([1, 2, 3, 4]);
    expect(toJsonSerializable(uint8)).toBe('01020304');
  });

  it('serializes Map to plain object', () => {
    const map = new Map<string, any>([
      ['a', 1],
      ['b', BigInt(42)],
    ]);
    expect(toJsonSerializable(map)).toEqual({ a: 1, b: '42' });
  });

  it('handles null, undefined, arrays and nested objects', () => {
    expect(toJsonSerializable(null)).toBeNull();
    expect(toJsonSerializable(undefined)).toBeUndefined();
    expect(toJsonSerializable([BigInt(1), 'text', { nested: BigInt(2) }])).toEqual([
      '1',
      'text',
      { nested: '2' },
    ]);
  });
});

describe('SorobanStorageInputSchema', () => {
  it('accepts valid input with default durability', () => {
    const parsed = SorobanStorageInputSchema.parse({
      contractId: VALID_CONTRACT,
      keys: ['COUNTER'],
    });

    expect(parsed.contractId).toBe(VALID_CONTRACT);
    expect(parsed.keys).toEqual(['COUNTER']);
    expect(parsed.durability).toBe('persistent');
  });

  it('accepts valid durability options', () => {
    for (const durability of ['persistent', 'temporary', 'instance'] as const) {
      const parsed = SorobanStorageInputSchema.parse({
        contractId: VALID_CONTRACT,
        keys: ['KEY'],
        durability,
      });
      expect(parsed.durability).toBe(durability);
    }
  });

  it('rejects invalid contractId length', () => {
    expect(() =>
      SorobanStorageInputSchema.parse({
        contractId: 'CINVALID',
        keys: ['KEY'],
      })
    ).toThrow('Invalid Stellar contract ID');
  });

  it('rejects empty keys array', () => {
    expect(() =>
      SorobanStorageInputSchema.parse({
        contractId: VALID_CONTRACT,
        keys: [],
      })
    ).toThrow('At least one storage key must be specified');
  });
});

describe('SorobanStorageTool', () => {
  let tool: SorobanStorageTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new SorobanStorageTool();
  });

  function makeMockEntry(keyVal: any, valVal: any, lastModified = 100, liveUntil = 200) {
    const keyScVal = keyVal instanceof xdr.ScVal ? keyVal : nativeToScVal(keyVal);
    const valScVal = valVal instanceof xdr.ScVal ? valVal : nativeToScVal(valVal);
    return {
      lastModifiedLedgerSeq: lastModified,
      liveUntilLedgerSeq: liveUntil,
      val: {
        contractData: () => ({
          key: () => keyScVal,
          val: () => valScVal,
        }),
      },
    };
  }

  it('queries storage entries and returns decoded results', async () => {
    const mockEntry = makeMockEntry('COUNTER', 42);
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockResolvedValue({
      entries: [mockEntry],
      latestLedger: 12345,
    } as any);

    const result = await tool.execute({
      contractId: VALID_CONTRACT,
      keys: ['COUNTER'],
    });

    expect(result.latestLedger).toBe(12345);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      key: 'COUNTER',
      value: 42,
      lastModifiedLedgerSeq: 100,
      liveUntilLedgerSeq: 200,
    });
    expect(rpcClient.sorobanServer.getLedgerEntries).toHaveBeenCalledTimes(1);
  });

  it('supports instance durability mapping', async () => {
    const mockEntry = makeMockEntry('INSTANCE_KEY', 'instance_value');
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockResolvedValue({
      entries: [mockEntry],
      latestLedger: 12345,
    } as any);

    const result = await tool.execute({
      contractId: VALID_CONTRACT,
      keys: ['IGNORED_FOR_INSTANCE'],
      durability: 'instance',
    });

    expect(result.entries[0].value).toBe('instance_value');
    expect(rpcClient.sorobanServer.getLedgerEntries).toHaveBeenCalledTimes(1);
  });

  it('supports temporary durability', async () => {
    const mockEntry = makeMockEntry('TEMP_KEY', 'temp_val');
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockResolvedValue({
      entries: [mockEntry],
      latestLedger: 12345,
    } as any);

    const result = await tool.execute({
      contractId: VALID_CONTRACT,
      keys: ['TEMP_KEY'],
      durability: 'temporary',
    });

    expect(result.entries[0].value).toBe('temp_val');
  });

  it('handles empty entries returned from RPC', async () => {
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockResolvedValue({
      entries: [],
      latestLedger: 12345,
    } as any);

    const result = await tool.execute({
      contractId: VALID_CONTRACT,
      keys: ['NONEXISTENT_KEY'],
    });

    expect(result.entries).toEqual([]);
    expect(result.latestLedger).toBe(12345);
  });

  it('propagates RPC errors', async () => {
    vi.mocked(rpcClient.sorobanServer.getLedgerEntries).mockRejectedValue(
      new Error('Soroban RPC connection error')
    );

    await expect(
      tool.execute({
        contractId: VALID_CONTRACT,
        keys: ['KEY'],
      })
    ).rejects.toThrow('Soroban RPC connection error');
  });
});
