import type { LightMyRequestResponse } from 'fastify';
import { afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config/env.js';
import { openDatabase, type Db } from '../src/infrastructure/database.js';
import { AiProviderError, type AiClient } from '../src/infrastructure/mock-ai.js';
import type { Clock } from '../src/shared/time.js';

/** 2026-01-01 10:00:00.000 UTC: exactly on an hour boundary. */
export const T0 = Date.UTC(2026, 0, 1, 10, 0, 0, 0);
export const HOUR = 3_600_000;

export class FakeClock implements Clock {
  constructor(public t: number = T0) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

type Behavior = 'ok' | 'fail' | 'hang' | 'manual';

interface Pending {
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * Fake AI with exact control:
 * - 'ok'     resolves immediately
 * - 'fail'   rejects immediately
 * - 'hang'   never answers (only the timeout ends it)
 * - 'manual' waits until the test calls succeedNext()/failNext()
 */
export class StubAi implements AiClient {
  behavior: Behavior = 'ok';
  calls = 0;
  private readonly pending: Pending[] = [];

  complete(prompt: string, signal: AbortSignal): Promise<string> {
    this.calls++;
    if (this.behavior === 'ok') return Promise.resolve(`answer to: ${prompt}`);
    if (this.behavior === 'fail') return Promise.reject(new AiProviderError('stub failure'));
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (this.behavior === 'manual') this.pending.push({ resolve: () => resolve(`answer to: ${prompt}`), reject });
    });
  }

  /** Wait until `n` requests are blocked inside the AI call. Fails fast instead of hanging the test. */
  async waitForCalls(n: number, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.length < n) {
      if (Date.now() > deadline) throw new Error(`expected ${n} pending AI calls, got ${this.pending.length}`);
      await new Promise((r) => setImmediate(r));
    }
  }

  succeedNext(): void {
    this.pending.shift()?.resolve();
  }

  failNext(): void {
    this.pending.shift()?.reject(new AiProviderError('stub failure'));
  }
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    QUOTA_LIMIT: '3',
    QUOTA_PERIOD_SECONDS: '3600',
    AI_TIMEOUT_MS: '60000',
    RESERVATION_TTL_MS: '120000',
    INSTANCE_ID: 'test-instance',
    REQUEST_HASH_SECRET: 'test-secret-0123456789',
    DB_SYNC: 'NORMAL', // tests don't need power-loss durability
    ...env,
  });
}

export interface TestContext {
  app: ReturnType<typeof buildApp>['app'];
  services: ReturnType<typeof buildApp>['services'];
  db: Db;
  clock: FakeClock;
  ai: StubAi;
  config: Config;
  setLimit(limit: number): void;
  /** POST an AI request through the real app (no network). */
  ask(userId: string, prompt?: string, idempotencyKey?: string): Promise<LightMyRequestResponse>;
  usage(userId: string): Promise<Record<string, unknown>>;
  events(userId: string, query?: string): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  dbPath?: string;
  sweepBatchSize?: number;
}

export async function createTestApp(env: Record<string, string> = {}, opts: TestAppOptions = {}): Promise<TestContext> {
  const config = testConfig(env);
  const db = openDatabase(opts.dbPath ?? ':memory:', { synchronous: config.dbSynchronous });
  const clock = new FakeClock();
  const ai = new StubAi();
  let limit = config.quotaLimit;
  const { app, services } = buildApp({ config, db, ai, clock, getLimit: () => limit, sweepBatchSize: opts.sweepBatchSize });
  await app.ready();

  return {
    app,
    services,
    db,
    clock,
    ai,
    config,
    setLimit: (l) => {
      limit = l;
    },
    ask: (userId, prompt = 'hello', idempotencyKey) =>
      app.inject({
        method: 'POST',
        url: `/v1/users/${userId}/ai-requests`,
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
        payload: { prompt },
      }),
    usage: async (userId) => (await app.inject({ url: `/v1/users/${userId}/usage` })).json(),
    events: async (userId, query = '') => (await app.inject({ url: `/v1/users/${userId}/usage/events${query}` })).json(),
    close: async () => {
      await app.close().catch(() => undefined); // a test may already have closed it
      if (db.open) db.close();
    },
  };
}

/**
 * Registers cleanup once per test file and returns a factory:
 *   const start = setupTestApp();
 *   const ctx = await start({ QUOTA_LIMIT: '1' });
 * The app created in each test is closed automatically after it.
 */
export function setupTestApp(): (env?: Record<string, string>, opts?: TestAppOptions) => Promise<TestContext> {
  let current: TestContext | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });
  return async (env = {}, opts = {}) => (current = await createTestApp(env, opts));
}

/** Direct ledger/counter read for invariant checks. */
export function ledgerCounts(db: Db, userId: string, periodStart: number) {
  const ledger = db
    .prepare<[string, number], { succeeded: number; reserved: number }>(
      `SELECT COALESCE(SUM(status = 'succeeded'), 0) AS succeeded, COALESCE(SUM(status = 'reserved'), 0) AS reserved
         FROM usage_events WHERE user_id = ? AND period_start = ?`,
    )
    .get(userId, periodStart)!;
  const counter = db
    .prepare<[string, number], { used: number; reserved: number }>(
      `SELECT used, reserved FROM usage_counters WHERE user_id = ? AND period_start = ?`,
    )
    .get(userId, periodStart) ?? { used: 0, reserved: 0 };
  return { ledger, counter };
}
