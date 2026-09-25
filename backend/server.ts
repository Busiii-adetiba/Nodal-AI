/**
 * backend/server.ts
 *
 * Health-check HTTP server for container orchestration (ECS, Kubernetes, etc.).
 *
 * Endpoints:
 *   GET /health  → 200 { status: "ok", components: { horizon, soroban, database } }
 *                  503 { status: "degraded", components: { ... } } when a dependency is down
 *   GET /status  → 200 { results: PersistedResult[] }   (last 10 AgentResult records)
 *
 * Uses only the Node.js built-in `http` module — no additional dependencies.
 * Port is read from config.HEALTH_PORT (env var HEALTH_PORT, default 3000).
 */

import * as http from 'http';
import { config } from './config';
import { getResults } from './persistence';
import { horizonServer, sorobanServer } from './rpc_client';
import { db } from './db/client';
import { handleError } from './middleware/error_handler';
import { createLogger } from './utils/logger';
import { spendingTracker } from './agent';

const log = createLogger('health-server');

// ─── Health types & component probes ─────────────────────────────────────────

/** Reachability of a single dependency. */
export type ComponentStatus = 'up' | 'down';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  components: {
    horizon: ComponentStatus;
    soroban: ComponentStatus;
    database: ComponentStatus;
  };
}

/**
 * Bound on a single probe.
 *
 * Without it an unreachable endpoint hangs until the socket's own timeout,
 * and an orchestrator's liveness probe times out first — reporting the agent
 * as dead rather than degraded, which triggers a restart instead of a
 * failover.
 */
const PROBE_TIMEOUT_MS = 3_000;

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Probe Horizon. */
export async function checkHorizon(): Promise<ComponentStatus> {
  try {
    await withTimeout(horizonServer.fetchBaseFee());
    return 'up';
  } catch (err) {
    log.warn({ msg: 'Horizon health probe failed', err: String(err) });
    return 'down';
  }
}

/**
 * Probe Soroban RPC (#233).
 *
 * Previously unchecked, so an agent whose Soroban RPC was down still reported
 * `status: "ok"` — while every `soroban_invoke` and `soroban_query` task
 * failed. Horizon being reachable says nothing about Soroban; they are
 * separate services on separate hosts.
 */
export async function checkSoroban(): Promise<ComponentStatus> {
  try {
    await withTimeout(sorobanServer.getNetwork());
    return 'up';
  } catch (err) {
    log.warn({ msg: 'Soroban RPC health probe failed', err: String(err) });
    return 'down';
  }
}

export async function checkDatabase(): Promise<ComponentStatus> {
  try {
    return (await withTimeout(db.healthCheck())) ? 'up' : 'down';
  } catch (err) {
    log.warn({ msg: 'Database health probe failed', err: String(err) });
    return 'down';
  }
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/**
 * Returns true if the request passes Bearer-token authentication.
 * When WEBHOOK_SECRET is unset, all requests are allowed.
 */
function isAuthenticated(req: http.IncomingMessage): boolean {
  if (!WEBHOOK_SECRET) return true;
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const [scheme, token] = auth.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token === WEBHOOK_SECRET;
}

const HEALTH_PATH = '/health';
const STATUS_PATH = '/status';
const SPENDING_PATH = '/spending';

/**
 * Creates and returns the health-check HTTP server.
 * Does NOT call `.listen()` — the caller (typically `index.ts`) is responsible
 * for binding to `config.HEALTH_PORT`.
 */
export function createHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    // ── GET /health ────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === HEALTH_PATH) {
      // Delegate to the real implementation: it probes Horizon, Soroban and
      // the database concurrently and reports 503 / "degraded" when any
      // dependency is down. The previous inline branch hardcoded
      // `status: "ok"` and never checked anything.
      void handleHealth(req, res);
      return;
    }

    // ── GET /status ────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === STATUS_PATH) {
      try {
        const results = getResults(10);
        const body = JSON.stringify({ results });

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      } catch (err) {
        // Route through the shared handler so a StructuredError gets the status
        // code that describes it instead of a blanket 500 - and so an internal
        // fault's message is not echoed to an unauthenticated caller.
        const errorResponse = handleError(err);
        const body = JSON.stringify(errorResponse);

        res.writeHead(errorResponse.status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...errorResponse.headers,
        });
        res.end(body);
      }
      return;
    }

    // ── GET /spending ──────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === SPENDING_PATH) {
      if (!isAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const total = spendingTracker.total();
      const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
      const body = JSON.stringify({
        total,
        limit,
        windowMs: config.SPENDING_WINDOW_MS,
        percentUsed: (total / limit) * 100,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // ── 404 for everything else ────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return server;
}

/**
 * Convenience: create the server and immediately start listening.
 * Returns the bound server instance.
 */
export function startHealthServer(): http.Server {
  const server = createHealthServer();
  const port = config.HEALTH_PORT;

  server.listen(port, () => {
    process.stdout.write(`✅ [HealthServer] Listening on port ${port}\n`);
    process.stdout.write(
      `   GET /health → { status, components }\n` +
        `   GET /status → { results: AgentResult[] }\n`
    );
  });

  return server;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    // Probed concurrently: run serially and a slow Horizon delays the Soroban
    // answer, so the endpoint's latency becomes the sum of every dependency.
    const [horizon, soroban, database] = await Promise.all([
      checkHorizon(),
      checkSoroban(),
      checkDatabase(),
    ]);

    const allUp = horizon === 'up' && soroban === 'up' && database === 'up';
    const statusCode = allUp ? 200 : 503;
    const body: HealthResponse = {
      status: allUp ? 'ok' : 'degraded',
      components: { horizon, soroban, database },
    };

    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (err) {
    const errorResponse = handleError(err);
    log.error({
      msg: 'Unhandled request error',
      status: errorResponse.status,
      type: errorResponse.type,
    });
    const body = JSON.stringify(errorResponse);
    res.writeHead(errorResponse.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...errorResponse.headers,
    });
    res.end(body);
  }
}
