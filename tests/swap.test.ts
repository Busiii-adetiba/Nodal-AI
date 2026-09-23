/**
 * tests/swap.test.ts
 * Tests for SwapTool path discovery, slippage guard, and path payment dispatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { SwapTool } from '../backend/tools/SwapTool';
import { ValidationError } from '../backend/errors';

const { mockStrictSendPathsCall, mockPathPaymentExecute } = vi.hoisted(() => ({
  mockStrictSendPathsCall: vi.fn(),
  mockPathPaymentExecute: vi.fn().mockResolvedValue({ txHash: 'swap_tx_hash', ledger: 42 }),
}));

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {
    strictSendPaths: () => ({
      call: mockStrictSendPathsCall,
    }),
  },
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  withRetry: (fn: () => unknown) => fn(),
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/tools/PathPaymentTool', () => {
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    PathPaymentTool: class {
      publicKey = Keypair.fromSecret(secret).publicKey();
      execute = mockPathPaymentExecute;
    },
  };
});

vi.mock('../backend/config', () => {
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function makePathRecord(destinationAmount: string) {
  return {
    destination_amount: destinationAmount,
    source_amount: '10.0000000',
    path: [],
    source_asset_type: 'native',
    destination_asset_type: 'credit_alphanum4',
    destination_asset_code: 'USDC',
    destination_asset_issuer: USDC_ISSUER,
  };
}

describe('SwapTool', () => {
  let tool: SwapTool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPathPaymentExecute.mockResolvedValue({ txHash: 'swap_tx_hash', ledger: 42 });
    tool = new SwapTool();
    mockStrictSendPathsCall.mockResolvedValue({
      records: [makePathRecord('9.5000000'), makePathRecord('9.4000000')],
    });
  });

  it('discovers the best path and submits via PathPaymentTool', async () => {
    const result = await tool.execute({
      sellAsset: { code: 'XLM' },
      buyAsset: { code: 'USDC', issuer: USDC_ISSUER },
      sellAmount: '10',
      maxSlippagePct: 5,
    });

    expect(result.txHash).toBe('swap_tx_hash');
    expect(result.ledger).toBe(42);
    expect(mockPathPaymentExecute).toHaveBeenCalledWith({
      destination: tool.publicKey,
      sendAsset: { code: 'XLM' },
      sendAmount: '10',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '9.0250000',
      path: [],
      allowSelfPayment: true,
    });
  });

  it('rejects swaps when no path is available', async () => {
    mockStrictSendPathsCall.mockResolvedValueOnce({ records: [] });

    await expect(
      tool.execute({
        sellAsset: { code: 'XLM' },
        buyAsset: { code: 'USDC', issuer: USDC_ISSUER },
        sellAmount: '10',
        maxSlippagePct: 5,
      })
    ).rejects.toThrow('No swap path found for the requested assets');
  });

  it('rejects swaps when slippage deviation exceeds tolerance', async () => {
    mockStrictSendPathsCall.mockResolvedValueOnce({
      records: [makePathRecord('10.0000000'), makePathRecord('8.0000000')],
    });

    await expect(
      tool.execute({
        sellAsset: { code: 'XLM' },
        buyAsset: { code: 'USDC', issuer: USDC_ISSUER },
        sellAmount: '10',
        maxSlippagePct: 5,
      })
    ).rejects.toThrow(ValidationError);

    expect(mockPathPaymentExecute).not.toHaveBeenCalled();
  });
});
