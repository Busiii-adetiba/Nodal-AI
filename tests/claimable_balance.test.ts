/**
 * tests/claimable_balance.test.ts
 * Tests for ClaimableBalanceTool (#389)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { ClaimableBalanceTool } from '../backend/tools/ClaimableBalanceTool';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {
    claimableBalances: vi.fn(),
  },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
  withRetry: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../backend/config', () => {
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
    },
  };
});

const TEST_SECRET = 'SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const BALANCE_ID = '000000009fa02f00b6b9a777edc785963a830424c7b1a3b3646255e6c7899652ab7b6065';

function makeMockAccount() {
  const publicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: 'native', balance: '100.0000000' }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
  };
}

describe('ClaimableBalanceTool', () => {
  let tool: ClaimableBalanceTool;
  let publicKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new ClaimableBalanceTool(TEST_SECRET);
    publicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'cb_hash',
      ledger: 10,
    } as any);
  });

  it('creates a claimable balance with claimants', async () => {
    const result = await tool.execute({
      action: 'create',
      assetCode: 'XLM',
      amount: '10',
      claimants: [{ destination: publicKey }],
    });

    expect(result.txHash).toBe('cb_hash');
    const submittedTx = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0];
    expect(submittedTx.operations[0]!.type).toBe('createClaimableBalance');
  });

  it('claims a balance after verifying claimant on Horizon', async () => {
    vi.mocked(rpcClient.horizonServer.claimableBalances).mockReturnValue({
      claimant: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ records: [{ id: BALANCE_ID }] }),
      }),
    } as any);

    const result = await tool.execute({ action: 'claim', balanceId: BALANCE_ID });

    expect(result.txHash).toBe('cb_hash');
    const submittedTx = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0];
    expect(submittedTx.operations[0]!.type).toBe('claimClaimableBalance');
  });

  it('rejects claim when agent is not a claimant', async () => {
    vi.mocked(rpcClient.horizonServer.claimableBalances).mockReturnValue({
      claimant: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ records: [] }),
      }),
    } as any);

    await expect(tool.execute({ action: 'claim', balanceId: BALANCE_ID })).rejects.toThrow(
      'Agent is not a claimant'
    );
  });

  it('retries claimant verification on transient failure', async () => {
    let attempts = 0;
    const mockCall = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('503 Service Unavailable');
      }
      return { records: [{ id: BALANCE_ID }] };
    });

    vi.mocked(rpcClient.horizonServer.claimableBalances).mockReturnValue({
      claimant: vi.fn().mockReturnValue({
        call: mockCall,
      }),
    } as any);

    vi.mocked(rpcClient.withRetry).mockImplementation(async (fn: () => unknown) => {
      try {
        return await fn();
      } catch {
        return await fn();
      }
    });

    const result = await tool.execute({ action: 'claim', balanceId: BALANCE_ID });

    expect(result.txHash).toBe('cb_hash');
    expect(rpcClient.withRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Number),
      expect.any(Number)
    );
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it('propagates error when claimant verification fails after retries', async () => {
    vi.mocked(rpcClient.horizonServer.claimableBalances).mockReturnValue({
      claimant: vi.fn().mockReturnValue({
        call: vi.fn().mockRejectedValue(new Error('RPC rate limit exceeded')),
      }),
    } as any);

    vi.mocked(rpcClient.withRetry).mockImplementation(async (fn: () => unknown) => {
      return await fn();
    });

    await expect(tool.execute({ action: 'claim', balanceId: BALANCE_ID })).rejects.toThrow(
      'RPC rate limit exceeded'
    );
  });

  it('creates USDC claimable balance with time predicate', async () => {
    const claimant = Keypair.random().publicKey();
    await tool.execute({
      action: 'create',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      amount: '5',
      claimants: [
        { destination: claimant, predicate: { type: 'beforeAbsoluteTime', timestamp: 9999999999 } },
      ],
    });

    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });
});
