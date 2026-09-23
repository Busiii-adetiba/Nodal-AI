/**
 * tests/x402.test.ts
 *
 * Comprehensive test suite for X402PaymentTool.
 * Covers: valid flow, schema validation, expiry, edge cases,
 * network failures during payment, and proof structure integrity.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hash, Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { X402PaymentTool } from '../backend/tools/X402PaymentTool';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import { config } from '../backend/config';
import { TransactionFailureError, ErrorType } from '../backend/errors';
import { horizonServer } from '../backend/rpc_client';

// ─── Mock rpc_client so horizonServer.ledgers() is interceptable ──────────────

vi.mock('../backend/rpc_client', () => ({
  // Pass-through so verification lookups exercise the mocked Horizon calls
  // directly, matching the shared withRetry wiring in X402PaymentTool.
  withRetry: (fn: () => Promise<unknown>) => fn(),
  horizonServer: {
    ledgers: vi.fn().mockReturnValue({
      ledger: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ closed_at: '2024-01-01T00:00:00Z' }),
      }),
    }),
    transactions: vi.fn().mockReturnValue({
      transaction: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ memo: '' }),
      }),
    }),
    operations: vi.fn().mockReturnValue({
      forTransaction: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ records: [] }),
      }),
    }),
  },
}));

// ─── Mock StellarPaymentTool so x402 tests don't hit Horizon ─────────────────

vi.mock('../backend/tools/StellarPaymentTool');

vi.mock('../backend/config', () => {
  const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_SECRET_KEY: secret,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      MAX_X402_PAYMENTS_PER_MINUTE: 10,
      MAX_SOROBAN_FEE_STROOPS: 1_000_000,
      ALLOWED_X402_ORIGINS: undefined,
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const VALID_PAY_TO = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const VALID_CHALLENGE = {
  resource: 'https://api.example.com/data',
  amount: '1.5000000',
  assetCode: 'USDC',
  assetIssuer: VALID_ISSUER,
  payTo: VALID_PAY_TO,
  nonce: '550e8400-e29b-41d4-a716-446655440000',
  expiresAt: futureIso(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('X402PaymentTool', () => {
  let tool: X402PaymentTool;
  let mockPaymentTool: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentTool = {
      publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      execute: vi.fn().mockResolvedValue({ txHash: 'x402_mock_tx_hash', ledger: 99 }),
    };
    vi.mocked(StellarPaymentTool).mockImplementation(() => mockPaymentTool);
    tool = new X402PaymentTool(TEST_SECRET);
  });

  // ── Schema validation ───────────────────────────────────────────────────────

  describe('Schema validation', () => {
    it('rejects a challenge with a missing nonce', async () => {
      const { nonce: _omit, ...noNonce } = VALID_CHALLENGE;
      await expect(tool.respond(noNonce)).rejects.toThrow();
    });

    it('rejects a non-UUID nonce', async () => {
      await expect(tool.respond({ ...VALID_CHALLENGE, nonce: 'not-a-uuid' })).rejects.toThrow(
        /UUID/
      );
    });

    it("rejects a challenge where payTo is the agent's own address", async () => {
      const agentPublicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
      await expect(tool.respond({ ...VALID_CHALLENGE, payTo: agentPublicKey })).rejects.toThrow(
        "Payment destination cannot be the agent's own address"
      );
    });

    it('rejects USDC payment when assetIssuer is empty', async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, assetCode: 'USDC', assetIssuer: '' })
      ).rejects.toThrow('assetIssuer is required for non-XLM payments');
    });

    it('accepts XLM payment without assetIssuer', async () => {
      const proof = await tool.respond({ ...VALID_CHALLENGE, assetCode: 'XLM', assetIssuer: '' });
      expect(proof.txHash).toBeTruthy();
    });

    it('rejects a missing resource URL', async () => {
      const { resource: _omit, ...noResource } = VALID_CHALLENGE;
      await expect(tool.respond(noResource)).rejects.toThrow();
    });

    it('rejects a non-URL resource field', async () => {
      await expect(tool.respond({ ...VALID_CHALLENGE, resource: 'not-a-url' })).rejects.toThrow(
        /URL/
      );
    });

    it('rejects a payTo address that is too short', async () => {
      await expect(tool.respond({ ...VALID_CHALLENGE, payTo: 'GBBD47' })).rejects.toThrow(
        /Stellar address/
      );
    });

    it('rejects missing expiresAt field', async () => {
      const { expiresAt: _omit, ...noExpiry } = VALID_CHALLENGE;
      await expect(tool.respond(noExpiry)).rejects.toThrow();
    });

    it('rejects an expiresAt that is not a valid ISO datetime', async () => {
      await expect(tool.respond({ ...VALID_CHALLENGE, expiresAt: 'not-a-date' })).rejects.toThrow();
    });

    it('rejects a completely empty object', async () => {
      await expect(tool.respond({})).rejects.toThrow();
    });

    it('rejects null input', async () => {
      await expect(tool.respond(null)).rejects.toThrow();
    });
  });

  // ── Expiry guard ─────────────────────────────────────────────────────────────

  describe('Expiry guard', () => {
    it('rejects a challenge expired 1 ms ago', async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, expiresAt: new Date(Date.now() - 1).toISOString() })
      ).rejects.toThrow(/expired/);
    });

    it('rejects a challenge expired 1 hour ago', async () => {
      await expect(
        tool.respond({
          ...VALID_CHALLENGE,
          expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
        })
      ).rejects.toThrow(/expired/);
    });

    it('accepts a challenge expiring 1 ms from now', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const proof = await tool.respond({
        ...VALID_CHALLENGE,
        nonce: '770e8400-e29b-41d4-a716-446655440099',
        expiresAt: new Date(now + 1).toISOString(),
      });
      expect(proof.txHash).toBeTruthy();
      vi.useRealTimers();
    });
  });

  // ── Rate limiting ────────────────────────────────────────────────────────────

  describe('Rate limiting', () => {
    function uniqueNonce(i: number): string {
      return `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    }

    it('allows up to MAX_X402_PAYMENTS_PER_MINUTE calls within the window', async () => {
      for (let i = 0; i < 10; i++) {
        // Each call must use a unique nonce — nonce replay protection fires before rate-limit
        const proof = await tool.respond({ ...VALID_CHALLENGE, nonce: uniqueNonce(i) });
        expect(proof.txHash).toBe('x402_mock_tx_hash');
      }
      expect(mockPaymentTool.execute).toHaveBeenCalledTimes(10);
    });

    it('throws on the 11th call within the same 60s window', async () => {
      for (let i = 0; i < 10; i++) {
        await tool.respond({ ...VALID_CHALLENGE, nonce: uniqueNonce(i) });
      }
      // 11th call — unique nonce but rate limit already hit
      await expect(tool.respond({ ...VALID_CHALLENGE, nonce: uniqueNonce(10) })).rejects.toThrow(
        'x402: rate limit exceeded'
      );
    });

    it('resets the counter after 60s window elapses', async () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      const farFutureExpiry = new Date(startTime + 180_000).toISOString();

      for (let i = 0; i < 10; i++) {
        await tool.respond({
          ...VALID_CHALLENGE,
          nonce: uniqueNonce(i),
          expiresAt: farFutureExpiry,
        });
      }
      // 11th call within same window — should hit rate limit
      await expect(
        tool.respond({ ...VALID_CHALLENGE, nonce: uniqueNonce(10), expiresAt: farFutureExpiry })
      ).rejects.toThrow('rate limit exceeded');

      // Advance past the 60s rate-limit window
      vi.setSystemTime(startTime + 60_001);

      // First call in new window with new nonce
      const proof = await tool.respond({
        ...VALID_CHALLENGE,
        nonce: uniqueNonce(11),
        expiresAt: farFutureExpiry,
      });
      expect(proof.txHash).toBe('x402_mock_tx_hash');
      vi.useRealTimers();
    });
  });

  describe('ALLOWED_X402_ORIGINS validation', () => {
    it('accepts a challenge from a trusted origin', async () => {
      (config as any).ALLOWED_X402_ORIGINS = 'api.example.com, other.com';
      const proof = await tool.respond(VALID_CHALLENGE);
      expect(proof.txHash).toBe('x402_mock_tx_hash');
    });

    it('rejects a challenge from an untrusted origin', async () => {
      (config as any).ALLOWED_X402_ORIGINS = 'trusted.com';
      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow(
        'x402: untrusted resource origin'
      );
    });

    it('disables wildcard (*) bypass', async () => {
      (config as any).ALLOWED_X402_ORIGINS = '*';
      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow(
        'x402: untrusted resource origin'
      );
    });

    afterEach(() => {
      (config as any).ALLOWED_X402_ORIGINS = undefined;
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe('Happy path', () => {
    it('returns a valid x402 payment proof structure', async () => {
      const proof = await tool.respond(VALID_CHALLENGE);

      expect(proof.protocol).toBe('x402');
      expect(proof.network).toBe('testnet');
      expect(proof.txHash).toBe('x402_mock_tx_hash');
      expect(proof.nonce).toBe(VALID_CHALLENGE.nonce);
      expect(proof.payer).toMatch(/^G[A-Z2-7]{55}$/);
      // signedAt is either ledger close time or wall-clock fallback — both are valid ISO strings
      expect(proof.signedAt).toBeTruthy();
      expect(() => new Date(proof.signedAt)).not.toThrow();
      expect(new Date(proof.signedAt).toISOString()).toBe(proof.signedAt);
    });

    it('embeds nonce in memo as SHA-256 fingerprint (28 hex chars)', async () => {
      await tool.respond(VALID_CHALLENGE);

      const callArg = mockPaymentTool.execute.mock.calls[0][0] as any;

      const expectedMemo = hash(Buffer.from(VALID_CHALLENGE.nonce)).toString('hex').slice(0, 28);
      expect(callArg.memo).toBe(expectedMemo);
      expect(callArg.memo.length).toBe(28);
    });

    it('delegates to StellarPaymentTool with correct destination and amount', async () => {
      await tool.respond(VALID_CHALLENGE);

      expect(mockPaymentTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: VALID_CHALLENGE.payTo,
          amount: VALID_CHALLENGE.amount,
          assetCode: VALID_CHALLENGE.assetCode,
          assetIssuer: VALID_CHALLENGE.assetIssuer,
        })
      );
    });

    it('omits assetIssuer for XLM payments', async () => {
      await tool.respond({ ...VALID_CHALLENGE, assetCode: 'XLM' });

      const callArg = mockPaymentTool.execute.mock.calls[0][0] as any;
      expect(callArg.assetIssuer).toBeUndefined();
    });

    it('calls StellarPaymentTool.execute exactly once per challenge', async () => {
      await tool.respond(VALID_CHALLENGE);

      expect(mockPaymentTool.execute).toHaveBeenCalledOnce();
    });
  });

  // ── Payment failure propagation ─────────────────────────────────────────────

  describe('Payment failure propagation', () => {
    function getMockExecute() {
      return mockPaymentTool.execute as ReturnType<typeof vi.fn>;
    }

    it('propagates insufficient funds from underlying payment', async () => {
      getMockExecute().mockRejectedValueOnce(
        new Error('Horizon: op_underfunded — insufficient balance')
      );

      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/underfunded/);
    });

    it('propagates network timeout from underlying payment', async () => {
      getMockExecute().mockRejectedValueOnce(new Error('ECONNABORTED: network timeout'));

      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/timeout/);
    });

    it('propagates trust line missing error', async () => {
      getMockExecute().mockRejectedValueOnce(
        new Error('Horizon: op_no_trust — recipient missing trust line for USDC')
      );

      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/no_trust/);
    });

    // ── #371: Horizon detail must survive as a structured error ──────────────

    it('wraps a Horizon submission failure as TransactionFailureError', async () => {
      getMockExecute().mockRejectedValueOnce(
        new Error('Horizon: op_underfunded — insufficient balance')
      );

      await expect(tool.respond(VALID_CHALLENGE)).rejects.toBeInstanceOf(TransactionFailureError);
    });

    it('keeps the Horizon result code and the original error as cause', async () => {
      const horizonError = new Error('Horizon: op_no_trust — missing trust line');
      getMockExecute().mockRejectedValueOnce(horizonError);

      const err = await tool.respond(VALID_CHALLENGE).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(TransactionFailureError);
      const failure = err as TransactionFailureError;
      expect(failure.errorType).toBe(ErrorType.TransactionFailure);
      // The result code is what tells an operator *why* it failed, so it has to
      // survive the wrap rather than being flattened to a generic message.
      expect(failure.message).toContain('op_no_trust');
      expect(failure.cause).toBe(horizonError);
    });

    it('preserves a txHash when Horizon rejected an already-submitted tx', async () => {
      const horizonError = Object.assign(new Error('Horizon: tx_failed'), {
        txHash: 'abc123def456',
      });
      getMockExecute().mockRejectedValueOnce(horizonError);

      const err = await tool.respond(VALID_CHALLENGE).catch((e: unknown) => e);

      expect((err as TransactionFailureError).txHash).toBe('abc123def456');
    });

    it('leaves txHash undefined when the failure never reached Horizon', async () => {
      getMockExecute().mockRejectedValueOnce(new Error('ECONNABORTED: network timeout'));

      const err = await tool.respond(VALID_CHALLENGE).catch((e: unknown) => e);

      // Nothing was submitted, so there is no hash to report — inventing one
      // would send an operator looking for a transaction that never existed.
      expect((err as TransactionFailureError).txHash).toBeUndefined();
    });
  });

  // ── Nonce replay protection ─────────────────────────────────────────────────

  describe('Nonce replay protection', () => {
    it('first use with a given nonce succeeds', async () => {
      await expect(tool.respond(VALID_CHALLENGE)).resolves.toHaveProperty(
        'nonce',
        VALID_CHALLENGE.nonce
      );
    });

    it('second use with the same nonce throws', async () => {
      await tool.respond(VALID_CHALLENGE);
      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow('x402: nonce already used');
    });

    it('allows a different nonce after a previous one was consumed', async () => {
      await tool.respond(VALID_CHALLENGE);
      const second = { ...VALID_CHALLENGE, nonce: '660e8400-e29b-41d4-a716-446655440001' };
      await expect(tool.respond(second)).resolves.toHaveProperty('nonce', second.nonce);
    });
  });

  // ── X402PaymentProof snapshot ──────────────────────────────────────────────

  describe('X402PaymentProof snapshot', () => {
    it('X402PaymentProof has expected shape and fields', async () => {
      // Pin the clock so signedAt is deterministic across runs
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-25T12:00:19.497Z'));

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const proof = await tool.respond(VALID_CHALLENGE);
      vi.useRealTimers();

      // signedAt changes every run so we verify structure rather than snapshot
      expect(proof).toMatchObject({
        protocol: 'x402',
        network: expect.any(String),
        txHash: expect.any(String),
        nonce: expect.any(String),
        payer: expect.any(String),
        signedAt: expect.any(String),
      });
      expect(proof).toHaveProperty('protocol', 'x402');
      expect(proof).toHaveProperty('network');
      expect(proof).toHaveProperty('txHash');
      expect(proof).toHaveProperty('nonce');
      expect(proof).toHaveProperty('payer');
      expect(proof).toHaveProperty('signedAt');

      vi.useRealTimers();
    });
  });

  // ── verify() ──────────────────────────────────────────────────────────────

  describe('verify()', () => {
    const NONCE = '550e8400-e29b-41d4-a716-446655440000';
    const EXPECTED_MEMO = createHash('sha256').update(NONCE).digest('hex').slice(0, 28);

    function getHorizonMock() {
      return vi.mocked(horizonServer);
    }

    function setupValidMocks() {
      const horizon = getHorizonMock();
      horizon.transactions.mockReturnValue({
        transaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({ memo: EXPECTED_MEMO }),
        }),
      } as any);
      horizon.operations.mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({
            records: [
              {
                to: VALID_PAY_TO,
                amount: '1.5000000',
                asset_code: 'USDC',
                from: Keypair.fromSecret(TEST_SECRET).publicKey(),
              },
            ],
          }),
        }),
      } as any);
    }

    const VALID_PROOF = {
      protocol: 'x402' as const,
      network: 'testnet',
      txHash: 'abc123',
      nonce: NONCE,
      payer: Keypair.fromSecret(TEST_SECRET).publicKey(),
      signedAt: new Date().toISOString(),
    };

    it('passes for a valid proof and matching challenge', async () => {
      setupValidMocks();
      await expect(tool.verify(VALID_PROOF, VALID_CHALLENGE)).resolves.toBeUndefined();
    });

    it('throws when destination does not match originalChallenge.payTo', async () => {
      setupValidMocks();
      const badChallenge = {
        ...VALID_CHALLENGE,
        payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      };
      // Override mock to return a different destination
      const horizon = getHorizonMock();
      horizon.operations.mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({
            records: [
              {
                to: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                amount: '1.5000000',
                asset_code: 'USDC',
                from: Keypair.fromSecret(TEST_SECRET).publicKey(),
              },
            ],
          }),
        }),
      } as any);
      await expect(tool.verify(VALID_PROOF, badChallenge)).rejects.toThrow('destination mismatch');
    });

    it('throws when amount does not match', async () => {
      setupValidMocks();
      const horizon = getHorizonMock();
      horizon.operations.mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({
            records: [
              {
                to: VALID_PAY_TO,
                amount: '99.0000000',
                asset_code: 'USDC',
                from: Keypair.fromSecret(TEST_SECRET).publicKey(),
              },
            ],
          }),
        }),
      } as any);
      await expect(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow('amount mismatch');
    });

    it('throws when assetCode does not match', async () => {
      setupValidMocks();
      const horizon = getHorizonMock();
      horizon.operations.mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({
            records: [
              {
                to: VALID_PAY_TO,
                amount: '1.5000000',
                asset_code: 'XLM',
                from: Keypair.fromSecret(TEST_SECRET).publicKey(),
              },
            ],
          }),
        }),
      } as any);
      await expect(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow('asset mismatch');
    });

    it('throws when memo does not match SHA-256(nonce)[0:28]', async () => {
      const horizon = getHorizonMock();
      horizon.transactions.mockReturnValue({
        transaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({ memo: 'wrongmemovalue123456789012' }),
        }),
      } as any);
      horizon.operations.mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({
            records: [
              {
                to: VALID_PAY_TO,
                amount: '1.5000000',
                asset_code: 'USDC',
                from: Keypair.fromSecret(TEST_SECRET).publicKey(),
              },
            ],
          }),
        }),
      } as any);
      await expect(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow('nonce mismatch');
    });

    it('throws when payer does not match proof.payer', async () => {
      setupValidMocks();
      const horizon = getHorizonMock();
      horizon.operations.mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({
            records: [
              {
                to: VALID_PAY_TO,
                amount: '1.5000000',
                asset_code: 'USDC',
                from: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              },
            ],
          }),
        }),
      } as any);
      await expect(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow('payer mismatch');
    });

    it('throws when the transaction has no operations', async () => {
      const horizon = getHorizonMock();
      horizon.transactions.mockReturnValue({
        transaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({ memo: EXPECTED_MEMO }),
        }),
      } as any);
      horizon.operations.mockReturnValue({
        forTransaction: vi.fn().mockReturnValue({
          call: vi.fn().mockResolvedValue({ records: [] }),
        }),
      } as any);
      await expect(tool.verify(VALID_PROOF, VALID_CHALLENGE)).rejects.toThrow('missing operation');
    });
  });
});
