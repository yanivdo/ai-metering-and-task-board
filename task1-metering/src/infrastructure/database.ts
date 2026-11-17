import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite runs inside this process (the engine ships with the better-sqlite3 npm package).
 * There is no database server to install or start: the database is a single local file,
 * created automatically on first start.
 */
export type Db = Database.Database;

/** Idempotent schema: applied on every startup, safe to run repeatedly. */
const SCHEMA = `
-- Append-only evidence ledger: one row per attempt that passed the quota check.
CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT    PRIMARY KEY,                 -- UUID v4, the reference given to a customer in a dispute
  user_id         TEXT    NOT NULL,
  idempotency_key TEXT,                                -- NULL when the client sent no key
  request_hash    TEXT    NOT NULL,                    -- SHA-256 of the prompt: proves what was asked without storing it
  prompt_chars    INTEGER NOT NULL CHECK (prompt_chars >= 0),
  period_start    INTEGER NOT NULL,                    -- epoch ms of the quota window this credit counts against
  quota_limit     INTEGER NOT NULL CHECK (quota_limit >= 0), -- the limit in force at reservation time
  status          TEXT    NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'expired')),
  error_code      TEXT    CHECK (error_code IS NULL OR error_code IN ('AI_ERROR', 'AI_TIMEOUT', 'RESERVATION_EXPIRED')),
  response_body   TEXT,                                -- kept only so idempotent retries can replay the result
  created_at      INTEGER NOT NULL,                    -- epoch ms, server clock
  finalized_at    INTEGER,
  latency_ms      INTEGER,
  instance_id     TEXT    NOT NULL
);

-- Retries with the same key can never create a second row (so never a second charge).
-- SQLite treats NULLs as distinct, so requests without a key are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_events_idempotency ON usage_events (user_id, idempotency_key);
-- Per-period audits and the counter/ledger invariant check.
CREATE INDEX IF NOT EXISTS ix_usage_events_user_period ON usage_events (user_id, period_start);
-- Keyset pagination for GET /usage/events: each page is a range scan of at most "limit" rows.
CREATE INDEX IF NOT EXISTS ix_usage_events_user_created ON usage_events (user_id, created_at DESC, id DESC);
-- Partial index: the sweeper only looks at the (few) rows still reserved.
CREATE INDEX IF NOT EXISTS ix_usage_events_reserved ON usage_events (created_at) WHERE status = 'reserved';

-- Hot-path counter: one row per user per period. Always updated in the same transaction
-- as the ledger row, so it can never drift from the evidence.
CREATE TABLE IF NOT EXISTS usage_counters (
  user_id      TEXT    NOT NULL,
  period_start INTEGER NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),     -- charged (succeeded)
  reserved     INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0), -- in flight
  PRIMARY KEY (user_id, period_start)
) WITHOUT ROWID;

-- Ledger immutability (edge case #18): evidence can't be deleted or rewritten, even by a bug.
CREATE TRIGGER IF NOT EXISTS usage_events_no_delete
BEFORE DELETE ON usage_events
BEGIN
  SELECT RAISE(ABORT, 'usage_events is append-only: delete is not allowed');
END;

-- Allowed transitions: reserved -> succeeded | failed | expired, and expired -> succeeded (late success).
-- Identity/evidence columns can never change.
CREATE TRIGGER IF NOT EXISTS usage_events_guard_update
BEFORE UPDATE ON usage_events
WHEN NOT (
       (OLD.status = 'reserved' AND NEW.status IN ('succeeded', 'failed', 'expired'))
    OR (OLD.status = 'expired'  AND NEW.status = 'succeeded')
  )
  OR NEW.id              IS NOT OLD.id
  OR NEW.user_id         IS NOT OLD.user_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_hash    IS NOT OLD.request_hash
  OR NEW.prompt_chars    IS NOT OLD.prompt_chars
  OR NEW.period_start    IS NOT OLD.period_start
  OR NEW.quota_limit     IS NOT OLD.quota_limit
  OR NEW.created_at      IS NOT OLD.created_at
  OR NEW.instance_id     IS NOT OLD.instance_id
BEGIN
  SELECT RAISE(ABORT, 'usage_events: illegal update of the evidence ledger');
END;
`;

export interface DbOptions {
  busyTimeoutMs?: number;
  synchronous?: 'FULL' | 'NORMAL';
}

/** The database file can't be created or opened (bad path, no permission, path is a directory, not a database) (#44). */
export class DatabaseOpenError extends Error {
  override name = 'DatabaseOpenError';
}

/**
 * Opens (or creates) the database file and applies the schema.
 *
 * - WAL: readers never block the writer and vice versa.
 * - synchronous: FULL (default) means a committed credit survives a power loss / OS crash, at the cost
 *   of a disk wait per commit; NORMAL trades that for latency (see DESIGN.md, edge case #34).
 * - busy_timeout: when another process/instance holds the write lock, wait up to N ms instead of
 *   failing immediately. Past that, the error becomes a 503 (fail closed).
 */
export function openDatabase(path: string, { busyTimeoutMs = 5000, synchronous = 'FULL' }: DbOptions = {}): Db {
  let db: Db | undefined;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = new Database(path);
    // A file that exists but isn't a database opens fine and only fails here, so this is inside the try.
    db.pragma('journal_mode = WAL');
    db.pragma(`synchronous = ${synchronous}`);
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.exec(SCHEMA);
    return db;
  } catch (err) {
    if (db?.open) db.close();
    throw new DatabaseOpenError(`cannot open database at "${path}": ${(err as Error).message}`, { cause: err });
  }
}

/**
 * Wraps fn in a BEGIN IMMEDIATE transaction. IMMEDIATE takes the write lock up front, so two
 * instances can't both read "1 credit left" and both reserve it: the second waits (busy_timeout)
 * and then sees the updated counter. Build the wrapper once and reuse it (no per-call overhead).
 */
export function immediateTransaction<A extends unknown[], R>(db: Db, fn: (...args: A) => R): (...args: A) => R {
  const tx = db.transaction(fn);
  return (...args: A) => tx.immediate(...args);
}
