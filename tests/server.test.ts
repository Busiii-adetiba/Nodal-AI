/**
 * tests/server.test.ts
 *
 * Tests for backend/server.ts — the health-check HTTP server.
 *
 * Strategy:
 *   - Mock `http.createServer` so we can capture the request handler
 *     without opening a real TCP port.
 *   - Mock `config` to provide deterministic values for STELLAR_NETWORK
 *     and AGENT_PUBLIC_KEY.
 *   - Mock `getResults` from persistence to inject controlled data for
 *     the /status endpoint.
 *   - Mock the dependency probes (checkHorizon/checkSoroban/checkDatabase)
 *     so /health can be exercised for both the healthy and degraded paths.
 *   - Invoke the captured handler with mock req/res objects and assert
 *     the response shapes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock modules before importing the module under test ──────────────────────

// Mock http module to capture the request handler
let capturedHandler: http.RequestListener | null = null;
vi.mock('http', () => ({
  createServer: vi.fn((handler: http.RequestListener) => {
    capturedHandler = handler;
    return {
      listen: vi.fn(),
      close: vi.fn(),
    };
  }),
}));

// Mock config module with deterministic values
vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    AGENT_PUBLIC_KEY: 'GTEST1234567890123456789012345678901234567890123456',
    HEALTH_PORT: 3000,
    // server.ts pulls in rpc_client, which builds a Horizon.Server at import
    // time; without these the URI constructor throws and the suite cannot load.
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  },
}));

// Mock persistence module — getResults returns controlled data, or throws
// when a test wants to exercise the error path.
let mockResults: any[] = [];
let mockResultsError: unknown = null;
vi.mock('../backend/persistence', () => ({
  getResults: vi.fn((limit?: number) => {
    if (mockResultsError) throw mockResultsError;
    return mockResults.slice(0, limit ?? 100);
  }),
}));

// Mock the dependency probes used by handleHealth(). Each defaults to a
// healthy result; individual tests override them to exercise the degraded
// path. The real implementations are never invoked in this suite.
let horizonOk = true;
let sorobanOk = true;
let databaseOk = true;
vi.mock('../backend/health', () => ({
  checkHorizon: vi.fn(async () => (horizonOk ? { ok: true } : { ok: false, error: 'horizon down' })),
  checkSoroban: vi.fn(async () => (sorobanOk ? { ok: true } : { ok: false, error: 'soroban down' })),
  checkDatabase: vi.fn(async () => (databaseOk ? { ok: true } : { ok: false, error: 'database down' })),
}));

import type * as http from 'http';
import { createHealthServer } from '../backend/server';
import {
  ContractError,
  NetworkTimeoutError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../backend/errors';
import { getResults } from '../backend/persistence';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(method: string, url: string): http.IncomingMessage {
  return { method, url } as http.IncomingMessage;
}

function makeRes(): http.ServerResponse & {
  _statusCode: number;
  _body: string;
  _headers: Record<string, any>;
} {
  const res: any = {
    _statusCode: 0,
    _body: '',
    _headers: {},
    writeHead: vi.fn(function (this: any, statusCode: number, headers?: Record<string, any>) {
      this._statusCode = statusCode;
      if (headers) Object.assign(this._headers, headers);
    }),
    end: vi.fn(function (this: any, body?: string) {
      this._body = body ?? '';
    }),
  };
  return res;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('backend/server.ts — health check HTTP server', () => {
  beforeEach(() => {
    capturedHandler = null;
    mockResults = [];
    mockResultsError = null;
    horizonOk = true;
    sorobanOk = true;
    databaseOk = true;
    vi.clearAllMocks();
  });

  it('creates an http server via http.createServer', () => {
    createHealthServer();
    // If createServer was called, our mock would have captured the handler
    expect(capturedHandler).toBeTypeOf('function');
  });

  describe('GET /health', () => {
    it("returns 200 with { status: 'ok', components } when all probes pass", async () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('ok');
      expect(body.components).toEqual({
        horizon: { ok: true },
        soroban: { ok: true },
        database: { ok: true },
      });
      expect(res._headers['Content-Type']).toBe('application/json');
    });

    it('health response matches expected shape', async () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toMatchSnapshot();
    });

    it('returns 503 with status "degraded" when Horizon is down', async () => {
      horizonOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.horizon.ok).toBe(false);
    });

    it('returns 503 with status "degraded" when Soroban is down', async () => {
      sorobanOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.soroban.ok).toBe(false);
    });

    it('returns 503 with status "degraded" when the database is down', async () => {
      databaseOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.database.ok).toBe(false);
    });
  });

  describe('GET /status', () => {
    it('returns 200 with { results: [] } when no persisted results exist', () => {
      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toEqual([]);
      expect(getResults).toHaveBeenCalledWith(10);
    });

    it('returns 200 with the last 10 AgentResult records from persistence', () => {
      const fakeResults = Array.from({ length: 15 }, (_, i) => ({
        timestamp: `2026-07-24T10:0${i}:00.000Z`,
        taskType: 'stellar_payment',
        success: true,
        data: { txHash: `hash_${i}` },
      }));
      mockResults = fakeResults;

      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toHaveLength(10);
      // Should be the first 10 from our mock (getResults returns newest-first)
      expect(body.results[0].data.txHash).toBe('hash_0');
    });

    it('returns 500 when persistence throws an error', () => {
      vi.mocked(getResults).mockImplementationOnce(() => {
        throw new Error('Database unavailable');
      });

      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(500);
      const body = JSON.parse(res._body);
      expect(body.type).toBe('InternalServerError');
      // The raw failure message is deliberately not echoed back: /status has no
      // auth guard, so an internal fault must not describe itself to callers.
      expect(res._body).not.toContain('Database unavailable');
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', () => {
      createHealthServer();
      const req = makeReq('GET', '/unknown');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(404);
    });

    it('returns 404 for POST /health', () => {
      createHealthServer();
      const req = makeReq('POST', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(404);
    });
  });

  describe('structured error responses', () => {
    async function requestStatusWith(err: unknown) {
      mockResultsError = err;
      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();
      await capturedHandler!(req, res);
      return res;
    }

    it('returns 400 when the handler throws a ValidationError', async () => {
      const res = await requestStatusWith(new ValidationError('bad limit'));
      expect(res._statusCode).toBe(400);
      expect(JSON.parse(res._body).type).toBe('ValidationError');
    });

    it('returns 401 when the handler throws an UnauthorizedError', async () => {
      const res = await requestStatusWith(new UnauthorizedError('nope'));
      expect(res._statusCode).toBe(401);
      expect(JSON.parse(res._body).type).toBe('UnauthorizedError');
    });

    it('returns 429 when the handler throws a RateLimitError', async () => {
      const res = await requestStatusWith(new RateLimitError('slow down'));
      expect(res._statusCode).toBe(429);
      expect(JSON.parse(res._body).type).toBe('RateLimitError');
    });

    it('returns 504 when the handler throws a NetworkTimeoutError', async () => {
      const res = await requestStatusWith(new NetworkTimeoutError('timeout'));
      expect(res._statusCode).toBe(504);
      expect(JSON.parse(res._body).type).toBe('NetworkTimeoutError');
    });

    it('returns 400 when the handler throws a ContractError', async () => {
      const res = await requestStatusWith(new ContractError('bad contract'));
      expect(res._statusCode).toBe(400);
      expect(JSON.parse(res._body).type).toBe('ContractError');
    });
  });
});
