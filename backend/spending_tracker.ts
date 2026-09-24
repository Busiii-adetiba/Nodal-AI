import { config } from './config';
import { logger } from './logger';
import {
  clearSpendingRecords,
  loadSpendingRecords,
  pruneSpendingRecords,
  saveSpendingRecord,
} from './persistence';

/**
 * Spending tracker that records each payment amount and maintains a rolling
 * time window. It is used by the agent to enforce a cumulative spending limit
 * within `config.SPENDING_WINDOW_MS`.
 *
 * The window is mirrored to SQLite (#372). Holding it only in memory meant a
 * restart reset the cumulative total to zero, so an agent that was restarted —
 * or that crashed and was restarted for it — could spend past its cap by
 * starting over with a clean slate. Records are reloaded on construction and
 * written on every `record()`.
 *
 * Persistence is best-effort: if the database is unavailable the tracker still
 * enforces the limit for the life of the process rather than refusing to run.
 */
export class SpendingTracker {
  private readonly windowMs: number;
  private records: { amount: number; timestamp: number }[] = [];

  constructor(windowMs: number = config.SPENDING_WINDOW_MS) {
    this.windowMs = windowMs;
    this.restore();
  }

  /**
   * Load the unexpired part of the window left behind by a previous process.
   */
  private restore(): void {
    const cutoff = Date.now() - this.windowMs;
    try {
      this.records = loadSpendingRecords(cutoff).map((r) => ({
        amount: r.amount,
        timestamp: r.timestamp,
      }));
      if (this.records.length > 0) {
        logger.info('Restored spending window from persistence', {
          records: this.records.length,
          total: this.total(),
        });
      }
    } catch (err) {
      // No database, or it is unreadable — carry on with an empty window.
      logger.warn('Could not restore spending window; starting empty', {
        error: String(err),
      });
      this.records = [];
    }
  }

  /**
   * Record a payment amount. The amount is expected to be a numeric string.
   * Throws if the new cumulative total exceeds `config.AGENT_SPENDING_LIMIT`.
   */
  record(amountStr: string) {
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) return; // let callers handle invalid input
    const now = Date.now();
    this.pruneOld(now);
    this.records.push({ amount, timestamp: now });
    this.persist({ amount, timestamp: now });
    const total = this.total();
    const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
    if (!isNaN(total) && !isNaN(limit)) {
      if (total > limit * 0.8) {
        logger.warn('Approaching spending limit', {
          total,
          limit,
          percent: ((total / limit) * 100).toFixed(1),
        });
      }
      if (total > limit) {
        throw new Error(`Cumulative spending ${total} exceeds limit ${limit}`);
      }
    }
  }

  /** Return the total amount spent within the current window. */
  total(): number {
    const now = Date.now();
    this.pruneOld(now);
    return this.calculateTotal();
  }

  /**
   * Return a snapshot of the current window state.
   *
   * @returns An object with:
   *   - `total` – cumulative spend within the active window
   *   - `recordCount` – number of records still within the window
   *   - `windowMs` – the configured window duration in milliseconds
   *   - `oldestTimestamp` – timestamp of the oldest in-window record, or `null` when empty
   */
  getWindowStatus(): {
    total: number;
    recordCount: number;
    windowMs: number;
    oldestTimestamp: number | null;
  } {
    const now = Date.now();
    this.pruneOld(now);
    return {
      total: this.calculateTotal(),
      recordCount: this.records.length,
      windowMs: this.windowMs,
      oldestTimestamp: this.records.length > 0 ? this.records[0]!.timestamp : null,
    };
  }

  /**
   * Calculate cumulative spending sum using BigInt stroop scaling (10_000_000n)
   * to avoid floating-point addition rounding error accumulation across records.
   */
  private calculateTotal(): number {
    const STROOP_SCALE = 10_000_000n;
    const totalStroops = this.records.reduce((sum, r) => {
      const str = r.amount.toFixed(7);
      const [whole = '0', fraction = ''] = str.split('.');
      const wholeBig = BigInt(whole);
      const fracBig = BigInt(fraction.padEnd(7, '0').slice(0, 7));
      const stroops = wholeBig < 0n || str.startsWith('-')
        ? wholeBig * STROOP_SCALE - fracBig
        : wholeBig * STROOP_SCALE + fracBig;
      return sum + stroops;
    }, 0n);
    return Number(totalStroops) / Number(STROOP_SCALE);
  }

  private persist(record: { amount: number; timestamp: number }): void {
    try {
      saveSpendingRecord(record);
    } catch (err) {
      // A spend that cannot be written down still counts in this process.
      logger.warn('Could not persist spending record', { error: String(err) });
    }
  }

  private pruneOld(now: number) {
    const cutoff = now - this.windowMs;
    let evicted = false;
    while (this.records.length > 0) {
      const first = this.records[0];
      if (first && first.timestamp < cutoff) {
        this.records.shift();
        evicted = true;
      } else {
        break;
      }
    }
    if (evicted) {
      try {
        pruneSpendingRecords(cutoff);
      } catch {
        // Pruning is housekeeping; failing to do it must not block a payment.
      }
    }
  }

  clear() {
    this.records = [];
    try {
      clearSpendingRecords();
    } catch {
      // Nothing persisted to clear.
    }
  }
}

/**
 * Process-wide singleton backing the cumulative spending window.
 *
 * Lives here (not in agent.ts) so value-moving tools — e.g.
 * {@link SorobanInvokeTool} — can record simulated SAC transfers against the
 * same window as payments without importing the agent (which would create a
 * module cycle) or instantiating a second tracker (whose in-memory state would
 * drift from the real one).
 */
export const spendingTracker = new SpendingTracker();
