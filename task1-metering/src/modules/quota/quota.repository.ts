import type { Db } from '../../infrastructure/database.js';

export interface CounterRow {
  used: number;
  reserved: number;
}

/** SQL for usage_counters only. Statements are prepared once (no per-request parse cost). */
export class QuotaRepository {
  private readonly ensureStmt;
  private readonly getStmt;
  private readonly tryReserveStmt;
  private readonly commitStmt;
  private readonly releaseStmt;
  private readonly chargeLateStmt;

  constructor(db: Db) {
    this.ensureStmt = db.prepare(
      `INSERT INTO usage_counters (user_id, period_start) VALUES (?, ?) ON CONFLICT DO NOTHING`,
    );
    this.getStmt = db.prepare<[string, number], CounterRow>(
      `SELECT used, reserved FROM usage_counters WHERE user_id = ? AND period_start = ?`,
    );
    // The quota check and the reservation are ONE conditional statement: it either reserves
    // or changes nothing. Same pattern as the Postgres production design (UPDATE ... WHERE ... RETURNING).
    this.tryReserveStmt = db.prepare(
      `UPDATE usage_counters SET reserved = reserved + 1
        WHERE user_id = ? AND period_start = ? AND used + reserved < ?`,
    );
    // "reserved > 0" turns a corrupt counter (reserved already 0) into "0 rows changed", the same
    // signal as a missing row, instead of a CHECK-constraint error (#41).
    this.commitStmt = db.prepare(
      `UPDATE usage_counters SET reserved = reserved - 1, used = used + 1
        WHERE user_id = ? AND period_start = ? AND reserved > 0`,
    );
    this.releaseStmt = db.prepare(
      `UPDATE usage_counters SET reserved = reserved - 1 WHERE user_id = ? AND period_start = ? AND reserved > 0`,
    );
    this.chargeLateStmt = db.prepare(
      `UPDATE usage_counters SET used = used + 1 WHERE user_id = ? AND period_start = ?`,
    );
  }

  get(userId: string, periodStart: number): CounterRow {
    return this.getStmt.get(userId, periodStart) ?? { used: 0, reserved: 0 };
  }

  /** Returns true if a credit was reserved. Must run inside a transaction. */
  tryReserve(userId: string, periodStart: number, limit: number): boolean {
    this.ensureStmt.run(userId, periodStart);
    return this.tryReserveStmt.run(userId, periodStart, limit).changes === 1;
  }

  // The three updates below return true only if exactly one counter row changed, so the caller
  // can detect a missing or corrupt row instead of silently not counting a credit (#41).

  /** reserved -> used (the credit is charged). */
  commit(userId: string, periodStart: number): boolean {
    return this.commitStmt.run(userId, periodStart).changes === 1;
  }

  /** reserved -> released (the credit returns to the user). */
  release(userId: string, periodStart: number): boolean {
    return this.releaseStmt.run(userId, periodStart).changes === 1;
  }

  /** A success that arrived after the sweeper already released the reservation. */
  chargeLate(userId: string, periodStart: number): boolean {
    return this.chargeLateStmt.run(userId, periodStart).changes === 1;
  }
}
