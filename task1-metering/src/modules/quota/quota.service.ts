import { immediateTransaction, type Db } from '../../infrastructure/database.js';
import type { Logger } from '../../shared/logger.js';
import { periodEnd, periodStart, secondsUntil, toIso, type Clock } from '../../shared/time.js';
import type { UsageRepository } from '../usage/usage.repository.js';
import type { QuotaRepository } from './quota.repository.js';

/** What a user sees about their quota for the current period. */
export interface UsageSnapshot {
  userId: string;
  limit: number;
  /** Charged credits (successful requests). */
  used: number;
  /** Credits reserved by requests still running. */
  inFlight: number;
  /** Never negative, even if the limit was lowered below current usage (edge case #12). */
  remaining: number;
  periodStart: string;
  periodEnd: string;
}

export interface QuotaOptions {
  periodMs: number;
  /** A function rather than a number so a changed limit applies on the very next request (#12, #13). */
  getLimit: () => number;
  /** Max reservations expired per sweeper transaction (#33). */
  sweepBatchSize?: number;
}

export type ReserveResult = { ok: true; periodStart: number; limit: number } | { ok: false };

/**
 * How a reservation ends:
 * - charge:      reserved -> used (the AI answered)
 * - release:     reserved -> returned to the user (the AI failed / timed out)
 * - charge_late: the sweeper already released it, but the AI answered after all (#9)
 */
export type Settlement = 'charge' | 'release' | 'charge_late';

/**
 * The counter row a ledger row refers to is missing or has no reservation to settle (a bug or a manual
 * DB change). Thrown inside the finalize transaction so it rolls back: a success is never recorded
 * without being counted (#41).
 */
export class CounterInvariantError extends Error {
  override name = 'CounterInvariantError';
  constructor(userId: string, periodStartMs: number, settlement: Settlement) {
    super(`usage_counters row missing or corrupt for user=${userId} period=${toIso(periodStartMs)} (${settlement})`);
  }
}

/**
 * All rules of the per-user, fixed-window quota live here.
 * reserve() and settle() do NOT open their own transaction: the usage service calls them inside
 * its transaction, so the counter and the ledger row are always committed together.
 */
export class QuotaService {
  private readonly sweepBatchTx: (cutoff: number, now: number, batchSize: number) => { examined: number; expired: number };

  constructor(
    db: Db,
    private readonly counters: QuotaRepository,
    private readonly events: UsageRepository,
    private readonly clock: Clock,
    private readonly opts: QuotaOptions,
    private readonly log: Logger,
  ) {
    this.sweepBatchTx = immediateTransaction(db, (cutoff: number, now: number, batchSize: number) => {
      const stale = this.events.findStaleReserved(cutoff, batchSize);
      let expired = 0;
      for (const r of stale) {
        // Guarded update: if the request finalized in the meantime, leave it alone.
        if (!this.events.markExpired(r.id, now)) continue;
        expired++;
        // A missing or corrupt counter row means there is nothing to release. Log it, but don't throw:
        // one corrupt row must not block crash recovery for everyone else (#41).
        if (!this.counters.release(r.userId, r.periodStart)) {
          this.log.error({ requestId: r.id, userId: r.userId }, 'sweeper: counter row missing or corrupt; nothing to release');
        }
      }
      return { examined: stale.length, expired };
    });
  }

  limit(): number {
    return this.opts.getLimit();
  }

  /**
   * Must run inside a transaction. Pins the request to the period of `nowMs` (#10, #11) and
   * reserves one credit if used + reserved < limit, in a single conditional statement.
   */
  reserve(userId: string, nowMs: number): ReserveResult {
    const start = periodStart(nowMs, this.opts.periodMs);
    const limit = this.limit();
    return this.counters.tryReserve(userId, start, limit) ? { ok: true, periodStart: start, limit } : { ok: false };
  }

  /** Must run inside a transaction. Throws CounterInvariantError (rolling it back) if the counter row is missing or corrupt. */
  settle(userId: string, periodStartMs: number, settlement: Settlement): void {
    let applied: boolean;
    switch (settlement) {
      case 'charge':
        applied = this.counters.commit(userId, periodStartMs);
        break;
      case 'release':
        applied = this.counters.release(userId, periodStartMs);
        break;
      case 'charge_late':
        applied = this.counters.chargeLate(userId, periodStartMs);
        break;
    }
    if (!applied) throw new CounterInvariantError(userId, periodStartMs, settlement);
  }

  /** Seconds until the quota resets, or null when waiting won't help because the limit is 0 (#27). */
  retryAfterSeconds(nowMs: number): number | null {
    if (this.limit() === 0) return null;
    return secondsUntil(periodEnd(periodStart(nowMs, this.opts.periodMs), this.opts.periodMs), nowMs);
  }

  getUsage(userId: string, nowMs: number = this.clock.now()): UsageSnapshot {
    const start = periodStart(nowMs, this.opts.periodMs);
    const { used, reserved } = this.counters.get(userId, start);
    const limit = this.limit();
    return {
      userId,
      limit,
      used,
      inFlight: reserved,
      remaining: Math.max(0, limit - used - reserved),
      periodStart: toIso(start),
      periodEnd: toIso(periodEnd(start, this.opts.periodMs)),
    };
  }

  /**
   * Crash recovery (#8): a reservation older than ttlMs belongs to a request whose instance died
   * (or whose finalize failed). Mark it expired and give the credit back; the row stays as evidence.
   * Works in bounded batches, each its own short transaction, so a large backlog after an outage
   * never holds the write lock for long (#33). Returns how many reservations were expired.
   */
  sweepExpired(ttlMs: number): number {
    const batchSize = this.opts.sweepBatchSize ?? 500;
    const now = this.clock.now();
    let total = 0;
    for (;;) {
      const { examined, expired } = this.sweepBatchTx(now - ttlMs, now, batchSize);
      total += expired;
      if (examined < batchSize) return total;
    }
  }
}
