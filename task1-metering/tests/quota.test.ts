import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { periodEnd, periodStart, secondsUntil } from '../src/shared/time.js';
import { HOUR, ledgerCounts, setupTestApp, T0 } from './helpers.js';

const start = setupTestApp();

describe('fixed-window period math (#10)', () => {
  it('start is inclusive, end is exclusive', () => {
    expect(periodStart(T0, HOUR)).toBe(T0);
    expect(periodStart(T0 + HOUR - 1, HOUR)).toBe(T0); // 10:59:59.999 -> 10:00 window
    expect(periodStart(T0 + HOUR, HOUR)).toBe(T0 + HOUR); // 11:00:00.000 -> 11:00 window
    expect(periodEnd(T0, HOUR)).toBe(T0 + HOUR);
  });

  it('all users share the same windows (alice at 10:05 and bob at 10:00 are both in 10:00-11:00)', () => {
    expect(periodStart(T0 + 5 * 60_000, HOUR)).toBe(periodStart(T0, HOUR));
  });

  it('Retry-After is whole seconds, never below 1', () => {
    expect(secondsUntil(T0 + HOUR, T0 + HOUR / 2)).toBe(1800);
    expect(secondsUntil(T0 + HOUR, T0 + HOUR - 1)).toBe(1);
  });
});

describe('config validation (#15, #28, #34)', () => {
  const base = { AI_TIMEOUT_MS: '1000', RESERVATION_TTL_MS: '5000' };
  it.each([
    ['negative limit', { QUOTA_LIMIT: '-1' }],
    ['non-numeric limit', { QUOTA_LIMIT: 'ten' }],
    ['fractional limit', { QUOTA_LIMIT: '2.5' }],
    ['zero period', { QUOTA_PERIOD_SECONDS: '0' }],
    ['failure rate above 1', { AI_FAILURE_RATE: '1.5' }],
    ['min delay > max delay', { AI_MIN_DELAY_MS: '500', AI_MAX_DELAY_MS: '100' }],
    ['TTL not greater than AI timeout', { AI_TIMEOUT_MS: '5000', RESERVATION_TTL_MS: '5000' }],
    ['hash secret shorter than 16 chars (#28)', { REQUEST_HASH_SECRET: 'short' }],
    ['unknown DB_SYNC mode (#34)', { DB_SYNC: 'OFF' }],
    ['shutdown timeout below 100 ms (#37)', { SHUTDOWN_TIMEOUT_MS: '10' }],
    ['non-numeric failure rate', { AI_FAILURE_RATE: 'often' }],
    ['AI timeout above the 32-bit timer limit (#42)', { AI_TIMEOUT_MS: '2147483648', RESERVATION_TTL_MS: '3000000000' }],
    ['sweep interval above the timer limit (#42)', { SWEEP_INTERVAL_MS: '3000000000' }],
    ['shutdown timeout above the timer limit (#42)', { SHUTDOWN_TIMEOUT_MS: '3000000000' }],
    ['AI max delay above the timer limit (#42)', { AI_MAX_DELAY_MS: '3000000000' }],
    ['quota period above 10 years (#42)', { QUOTA_PERIOD_SECONDS: '315360001' }],
    ['unknown LOG_LEVEL (#43)', { LOG_LEVEL: 'verbose' }],
  ])('rejects %s', (_name, env) => {
    expect(() => loadConfig({ ...base, ...env })).toThrow(ConfigError);
  });

  it('accepts defaults, a limit of 0, and enum values in any case', () => {
    const defaults = loadConfig({});
    expect(defaults).toMatchObject({ quotaLimit: 10, dbSynchronous: 'FULL', logLevel: 'info', usingDefaultHashSecret: true });
    expect(loadConfig({ QUOTA_LIMIT: '0' }).quotaLimit).toBe(0);
    expect(loadConfig({ DB_SYNC: 'normal', LOG_LEVEL: 'WARN' })).toMatchObject({ dbSynchronous: 'NORMAL', logLevel: 'warn' });
    expect(loadConfig({ REQUEST_HASH_SECRET: 'a-real-secret-0123456789' }).usingDefaultHashSecret).toBe(false);
  });

  it('accepts timer values exactly at the 32-bit limit (#42)', () => {
    expect(loadConfig({ AI_TIMEOUT_MS: '2147483647', RESERVATION_TTL_MS: '2147483648' }).aiTimeoutMs).toBe(2_147_483_647);
  });
});

describe('quota enforcement', () => {
  it('allows exactly X requests per period, then 429', async () => {
    const ctx = await start({ QUOTA_LIMIT: '3' });
    for (let i = 0; i < 3; i++) expect((await ctx.ask('alice')).statusCode).toBe(200);
    expect((await ctx.ask('alice')).statusCode).toBe(429);
    expect(await ctx.usage('alice')).toMatchObject({ used: 3, inFlight: 0, remaining: 0, limit: 3 });
  });

  it('each user has an independent quota', async () => {
    const ctx = await start({ QUOTA_LIMIT: '2' });
    await ctx.ask('alice');
    await ctx.ask('alice');
    expect((await ctx.ask('alice')).statusCode).toBe(429);
    expect((await ctx.ask('bob')).statusCode).toBe(200);
    expect(await ctx.usage('bob')).toMatchObject({ used: 1, remaining: 1 });
  });

  it('user ids are case-sensitive opaque identifiers: "Alice" and "alice" are different users (#31)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1' });
    expect((await ctx.ask('alice')).statusCode).toBe(200);
    expect((await ctx.ask('Alice')).statusCode).toBe(200);
    expect((await ctx.ask('alice')).statusCode).toBe(429);
  });

  it('X = 0 blocks every request and never calls the AI (#14)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '0' });
    expect((await ctx.ask('alice')).statusCode).toBe(429);
    expect(ctx.ai.calls).toBe(0);
  });

  it('lowering X below current usage: remaining is 0 (not negative), new requests blocked, history kept (#12)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '3' });
    await ctx.ask('alice');
    await ctx.ask('alice');
    ctx.setLimit(1);
    expect(await ctx.usage('alice')).toMatchObject({ used: 2, remaining: 0, limit: 1 });
    expect((await ctx.ask('alice')).statusCode).toBe(429);
    expect((await ctx.events('alice')).items).toHaveLength(2);
  });

  it('raising X mid-period takes effect on the next request (#13)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1' });
    await ctx.ask('alice');
    expect((await ctx.ask('alice')).statusCode).toBe(429);
    ctx.setLimit(2);
    expect((await ctx.ask('alice')).statusCode).toBe(200);
  });

  it('a request at 10:59:59.999 counts in the old period; at 11:00:00.000 the quota is fresh (#10)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1' });
    ctx.clock.set(T0 + HOUR - 1);
    expect((await ctx.ask('alice')).statusCode).toBe(200);
    expect((await ctx.ask('alice')).statusCode).toBe(429);
    ctx.clock.set(T0 + HOUR);
    expect((await ctx.ask('alice')).statusCode).toBe(200);
    expect(ledgerCounts(ctx.db, 'alice', T0).counter.used).toBe(1);
    expect(ledgerCounts(ctx.db, 'alice', T0 + HOUR).counter.used).toBe(1);
  });

  it('an in-flight request that crosses the boundary is charged to the period it was reserved in (#11)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1' });
    ctx.ai.behavior = 'manual';
    ctx.clock.set(T0 + HOUR - 100);
    const pending = ctx.ask('alice');
    await ctx.ai.waitForCalls(1);
    ctx.clock.set(T0 + HOUR + 100); // the AI answers after the boundary
    ctx.ai.succeedNext();
    expect((await pending).statusCode).toBe(200);
    expect(ledgerCounts(ctx.db, 'alice', T0).counter).toEqual({ used: 1, reserved: 0 });
    expect(ledgerCounts(ctx.db, 'alice', T0 + HOUR).counter).toEqual({ used: 0, reserved: 0 });
  });

  it('an in-flight request holds its credit, so a concurrent request cannot overshoot', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1' });
    ctx.ai.behavior = 'manual';
    const first = ctx.ask('alice');
    await ctx.ai.waitForCalls(1);
    expect(await ctx.usage('alice')).toMatchObject({ used: 0, inFlight: 1, remaining: 0 });
    expect((await ctx.ask('alice')).statusCode).toBe(429);
    ctx.ai.succeedNext();
    expect((await first).statusCode).toBe(200);
  });
});

describe('crash recovery sweeper (#8, #9, #33)', () => {
  it('expires a stuck reservation, returns the credit, and keeps the row as evidence; a late success is charged', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1', RESERVATION_TTL_MS: '120000' });
    ctx.ai.behavior = 'manual';
    const pending = ctx.ask('alice'); // simulates an instance that "died" mid-request
    await ctx.ai.waitForCalls(1);

    ctx.clock.advance(60_000); // not old enough yet
    expect(ctx.services.quota.sweepExpired(ctx.config.reservationTtlMs)).toBe(0);

    ctx.clock.advance(61_000);
    expect(ctx.services.quota.sweepExpired(ctx.config.reservationTtlMs)).toBe(1);
    expect(await ctx.usage('alice')).toMatchObject({ used: 0, inFlight: 0, remaining: 1 });
    expect(ctx.db.prepare(`SELECT status, error_code AS errorCode FROM usage_events`).get())
      .toEqual({ status: 'expired', errorCode: 'RESERVATION_EXPIRED' });

    // The AI finally answers: the user received the value, so it is charged (#9).
    ctx.ai.succeedNext();
    expect((await pending).statusCode).toBe(200);
    expect(await ctx.usage('alice')).toMatchObject({ used: 1, inFlight: 0 });
    expect(ctx.db.prepare(`SELECT status FROM usage_events`).get()).toEqual({ status: 'succeeded' });
  });

  it('a late failure after expiry does not release the credit twice', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1' });
    ctx.ai.behavior = 'manual';
    const pending = ctx.ask('alice');
    await ctx.ai.waitForCalls(1);
    ctx.clock.advance(ctx.config.reservationTtlMs + 1);
    ctx.services.quota.sweepExpired(ctx.config.reservationTtlMs);
    ctx.ai.failNext();
    await pending;
    expect(ledgerCounts(ctx.db, 'alice', T0).counter).toEqual({ used: 0, reserved: 0 });
    expect(ctx.db.prepare(`SELECT status FROM usage_events`).get()).toEqual({ status: 'expired' });
  });

  it('never touches finalized rows', async () => {
    const ctx = await start();
    await ctx.ask('alice');
    ctx.clock.advance(ctx.config.reservationTtlMs * 10);
    expect(ctx.services.quota.sweepExpired(ctx.config.reservationTtlMs)).toBe(0);
  });

  it('works through a large backlog in small batches (each its own short transaction) (#33)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '10' }, { sweepBatchSize: 2 });
    ctx.ai.behavior = 'manual';
    const pending = Array.from({ length: 5 }, (_, i) => ctx.ask(`user${i}`));
    await ctx.ai.waitForCalls(5);
    ctx.clock.advance(ctx.config.reservationTtlMs + 1);

    expect(ctx.services.quota.sweepExpired(ctx.config.reservationTtlMs)).toBe(5);
    expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE status = 'expired'`).get()).toEqual({ n: 5 });
    expect(ctx.db.prepare(`SELECT SUM(reserved) AS r FROM usage_counters`).get()).toEqual({ r: 0 });

    for (let i = 0; i < 5; i++) ctx.ai.failNext();
    await Promise.all(pending);
  });
});

describe('counter = ledger invariant (#19)', () => {
  it('holds after a mix of successes, failures, rejections and in-flight requests', async () => {
    const ctx = await start({ QUOTA_LIMIT: '6' });
    await ctx.ask('alice');
    ctx.ai.behavior = 'fail';
    await ctx.ask('alice');
    ctx.ai.behavior = 'ok';
    await ctx.ask('alice');
    ctx.ai.behavior = 'manual';
    const pending = [ctx.ask('alice'), ctx.ask('alice')];
    await ctx.ai.waitForCalls(2);

    let { ledger, counter } = ledgerCounts(ctx.db, 'alice', T0);
    expect(counter).toEqual({ used: ledger.succeeded, reserved: ledger.reserved });
    expect(counter).toEqual({ used: 2, reserved: 2 });

    ctx.ai.succeedNext();
    ctx.ai.failNext();
    await Promise.all(pending);
    ({ ledger, counter } = ledgerCounts(ctx.db, 'alice', T0));
    expect(counter).toEqual({ used: ledger.succeeded, reserved: ledger.reserved });
    expect(counter).toEqual({ used: 3, reserved: 0 });
  });
});
