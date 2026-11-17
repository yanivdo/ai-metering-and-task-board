import type { Db } from '../../infrastructure/database.js';

export type EventStatus = 'reserved' | 'succeeded' | 'failed' | 'expired';
export type EventErrorCode = 'AI_ERROR' | 'AI_TIMEOUT' | 'RESERVATION_EXPIRED';

/** One row of the evidence ledger, in camelCase. */
export interface UsageEvent {
  id: string;
  userId: string;
  idempotencyKey: string | null;
  requestHash: string;
  promptChars: number;
  periodStart: number;
  quotaLimit: number;
  status: EventStatus;
  errorCode: EventErrorCode | null;
  responseBody: string | null;
  createdAt: number;
  finalizedAt: number | null;
  latencyMs: number | null;
  instanceId: string;
}

export type NewReservedEvent = Pick<
  UsageEvent,
  'id' | 'userId' | 'idempotencyKey' | 'requestHash' | 'promptChars' | 'periodStart' | 'quotaLimit' | 'createdAt' | 'instanceId'
>;

export interface StaleReservation {
  id: string;
  userId: string;
  periodStart: number;
}

/** Keyset cursor: the (createdAt, id) of the last row of the previous page. */
export interface PageCursor {
  createdAt: number;
  id: string;
}

const COLUMNS = `
  id, user_id AS userId, idempotency_key AS idempotencyKey, request_hash AS requestHash,
  prompt_chars AS promptChars, period_start AS periodStart, quota_limit AS quotaLimit,
  status, error_code AS errorCode, response_body AS responseBody, created_at AS createdAt,
  finalized_at AS finalizedAt, latency_ms AS latencyMs, instance_id AS instanceId`;

/**
 * SQL for usage_events only. Every status change is guarded by the expected current status
 * (WHERE status = 'reserved'), so a row can't be finalized twice; callers check `changes`.
 * The DB triggers enforce the same rules as a second line of defence.
 */
export class UsageRepository {
  private readonly insertStmt;
  private readonly byKeyStmt;
  private readonly succeedStmt;
  private readonly succeedLateStmt;
  private readonly failStmt;
  private readonly expireStmt;
  private readonly staleStmt;
  private readonly firstPageStmt;
  private readonly nextPageStmt;

  constructor(db: Db) {
    this.insertStmt = db.prepare(`
      INSERT INTO usage_events
        (id, user_id, idempotency_key, request_hash, prompt_chars, period_start, quota_limit,
         status, created_at, instance_id)
      VALUES
        (@id, @userId, @idempotencyKey, @requestHash, @promptChars, @periodStart, @quotaLimit,
         'reserved', @createdAt, @instanceId)`);
    this.byKeyStmt = db.prepare<[string, string], UsageEvent>(
      `SELECT ${COLUMNS} FROM usage_events WHERE user_id = ? AND idempotency_key = ?`,
    );
    this.succeedStmt = db.prepare(`
      UPDATE usage_events SET status = 'succeeded', finalized_at = ?, latency_ms = ?, response_body = ?
       WHERE id = ? AND status = 'reserved'`);
    this.succeedLateStmt = db.prepare(`
      UPDATE usage_events SET status = 'succeeded', error_code = NULL, finalized_at = ?, latency_ms = ?, response_body = ?
       WHERE id = ? AND status = 'expired'`);
    this.failStmt = db.prepare(`
      UPDATE usage_events SET status = 'failed', error_code = ?, finalized_at = ?, latency_ms = ?
       WHERE id = ? AND status = 'reserved'`);
    this.expireStmt = db.prepare(`
      UPDATE usage_events SET status = 'expired', error_code = 'RESERVATION_EXPIRED', finalized_at = ?
       WHERE id = ? AND status = 'reserved'`);
    this.staleStmt = db.prepare<[number, number], StaleReservation>(`
      SELECT id, user_id AS userId, period_start AS periodStart
        FROM usage_events WHERE status = 'reserved' AND created_at < ?
       ORDER BY created_at LIMIT ?`);
    this.firstPageStmt = db.prepare<[string, number], UsageEvent>(`
      SELECT ${COLUMNS} FROM usage_events WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`);
    // Row-value comparison = "strictly after the cursor in (created_at DESC, id DESC) order".
    this.nextPageStmt = db.prepare<[string, number, string, number], UsageEvent>(`
      SELECT ${COLUMNS} FROM usage_events WHERE user_id = ? AND (created_at, id) < (?, ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`);
  }

  insertReserved(event: NewReservedEvent): void {
    this.insertStmt.run(event);
  }

  findByIdempotencyKey(userId: string, key: string): UsageEvent | undefined {
    return this.byKeyStmt.get(userId, key);
  }

  /** reserved -> succeeded. Returns false if the row was no longer reserved. */
  markSucceeded(id: string, finalizedAt: number, latencyMs: number, responseBody: string): boolean {
    return this.succeedStmt.run(finalizedAt, latencyMs, responseBody, id).changes === 1;
  }

  /** expired -> succeeded: the AI answered after the sweeper had given up on this reservation. */
  markSucceededLate(id: string, finalizedAt: number, latencyMs: number, responseBody: string): boolean {
    return this.succeedLateStmt.run(finalizedAt, latencyMs, responseBody, id).changes === 1;
  }

  /** reserved -> failed. Returns false if the row was no longer reserved. */
  markFailed(id: string, errorCode: EventErrorCode, finalizedAt: number, latencyMs: number): boolean {
    return this.failStmt.run(errorCode, finalizedAt, latencyMs, id).changes === 1;
  }

  /** reserved -> expired (sweeper). Returns false if it was finalized in the meantime. */
  markExpired(id: string, finalizedAt: number): boolean {
    return this.expireStmt.run(finalizedAt, id).changes === 1;
  }

  /** Oldest first, at most `limit` rows, so the sweeper works in bounded batches. */
  findStaleReserved(createdBefore: number, limit: number): StaleReservation[] {
    return this.staleStmt.all(createdBefore, limit);
  }

  /** Newest first. Fetch limit + 1 rows to know whether another page exists without a COUNT. */
  listPage(userId: string, limit: number, cursor?: PageCursor): UsageEvent[] {
    return cursor
      ? this.nextPageStmt.all(userId, cursor.createdAt, cursor.id, limit)
      : this.firstPageStmt.all(userId, limit);
  }
}
