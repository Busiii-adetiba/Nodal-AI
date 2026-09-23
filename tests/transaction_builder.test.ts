/**
 * tests/transaction_builder.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransactionBuilderTool } from '../backend/tools/TransactionBuilderTool';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: (network: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    require('@stellar/stellar-sdk').Networks[
      network === 'mainnet' ? 'PUBLIC' : network === 'futurenet' ? 'FUTURENET' : 'TESTNET'
    ],
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      AGENT_SPENDING_LIMIT: '1000',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const DEST1 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const DEST2 = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC_ISSUER = 'GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5';

function makeMockAccount(publicKey: string) {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: 'native', balance: '10000.0000000' }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: '',
    inflation_dest: null,
  };
}

describe('TransactionBuilderTool', () => {
  let tool: TransactionBuilderTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new TransactionBuilderTool();
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(
      makeMockAccount('GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5') as any
    );
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'multi_op_tx_hash',
      ledger: 42,
    } as any);
  });

  it('builds and submits a transaction from multiple operations', async () => {
    const result = await tool.execute({
      operations: [
        { type: 'payment', payload: { destination: DEST1, amount: '10', asset: 'XLM' } },
        {
          type: 'change_trust',
          payload: { assetCode: 'USDC', assetIssuer: USDC_ISSUER, limit: '1000' },
        },
      ],
    });

    expect(result.txHash).toBe('multi_op_tx_hash');
    expect(result.ledger).toBe(42);
    expect(result.operationsCount).toBe(2);
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  it('does not submit when simulateOnly is set', async () => {
    const result = await tool.execute({
      operations: [{ type: 'payment', payload: { destination: DEST1, amount: '10', asset: 'XLM' } }],
      simulateOnly: true,
    });

    expect(result.xdr).toEqual(expect.any(String));
    expect(result.txHash).toBeUndefined();
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects an empty operations array', async () => {
    await expect(tool.execute({ operations: [] })).rejects.toThrow();
  });

  it('throws for an unsupported task type', async () => {
    await expect(
      tool.execute({ operations: [{ type: 'not_a_real_task', payload: {} }] })
    ).rejects.toThrow(/Unsupported task type/);
  });

  it('applies a text memo to the built transaction', async () => {
    const result = await tool.execute({
      operations: [{ type: 'payment', payload: { destination: DEST2, amount: '5', asset: 'XLM' } }],
      memo: 'hello',
      simulateOnly: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { TransactionBuilder, Networks } = require('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(result.xdr, Networks.TESTNET);
    expect(tx.memo.value.toString()).toBe('hello');
  });
});
