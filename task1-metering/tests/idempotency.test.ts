import { describe, expect, it } from 'vitest';
import { HOUR, setupTestApp } from './helpers.js';

const start = setupTestApp();

describe('Idempotency-Key', () => {
  it('a retry with the same key is charged once and returns the same answer (#3)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    const first = await ctx.ask('alice', 'hello', 'key-1');
    const retry = await ctx.ask('alice', 'hello', 'key-1');

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toMatchObject({
      requestId: first.json().requestId,
      result: first.json().result,
      replayed: true,
      charged: true,
    });
    expect(ctx.ai.calls).toBe(1);
    expect(await ctx.usage('alice')).toMatchObject({ used: 1 });
  });

  it('a retry is replayed even when the quota is now exhausted (it is not a new request)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1' });
    await ctx.ask('alice', 'hello', 'key-1');
    expect((await ctx.ask('alice', 'other')).statusCode).toBe(429);
    expect((await ctx.ask('alice', 'hello', 'key-1')).statusCode).toBe(200);
  });

  it('the same key with a different prompt -> 422, nothing charged (#4)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    await ctx.ask('alice', 'hello', 'key-1');
    const res = await ctx.ask('alice', 'something else', 'key-1');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(await ctx.usage('alice')).toMatchObject({ used: 1 });
  });

  it('the same key while the first request is still running -> 409 (#5)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    ctx.ai.behavior = 'manual';
    const first = ctx.ask('alice', 'hello', 'key-1');
    await ctx.ai.waitForCalls(1);

    const dup = await ctx.ask('alice', 'hello', 'key-1');
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: { code: 'REQUEST_IN_PROGRESS' } });

    ctx.ai.succeedNext();
    expect((await first).statusCode).toBe(200);
    expect(ctx.ai.calls).toBe(1);
    expect(await ctx.usage('alice')).toMatchObject({ used: 1, inFlight: 0 });
  });

  it('a retry after a failure replays the failure without calling the AI again', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    ctx.ai.behavior = 'fail';
    expect((await ctx.ask('alice', 'hello', 'key-1')).statusCode).toBe(502);
    ctx.ai.behavior = 'ok';
    const retry = await ctx.ask('alice', 'hello', 'key-1');
    expect(retry.statusCode).toBe(502);
    expect(retry.json()).toMatchObject({ replayed: true, charged: false });
    expect(ctx.ai.calls).toBe(1);
    expect(await ctx.usage('alice')).toMatchObject({ used: 0 });
  });

  it('keys never expire: reused in a later period, the original result is replayed and nothing is charged (#29)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    const first = await ctx.ask('alice', 'hello', 'key-1');
    ctx.clock.advance(5 * HOUR);
    const later = await ctx.ask('alice', 'hello', 'key-1');
    expect(later.json()).toMatchObject({ requestId: first.json().requestId, replayed: true });
    expect(await ctx.usage('alice')).toMatchObject({ used: 0 }); // new period: nothing charged in it
  });

  it('a key whose request crashed mid-way returns 409 until the sweeper runs, then replays as not charged (#30)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    ctx.ai.behavior = 'manual';
    const crashed = ctx.ask('alice', 'hello', 'key-1'); // never answered: simulates a dead instance
    await ctx.ai.waitForCalls(1);

    expect((await ctx.ask('alice', 'hello', 'key-1')).statusCode).toBe(409);

    ctx.clock.advance(ctx.config.reservationTtlMs + 1);
    ctx.services.quota.sweepExpired(ctx.config.reservationTtlMs);
    const retry = await ctx.ask('alice', 'hello', 'key-1');
    expect(retry.statusCode).toBe(503);
    expect(retry.json()).toMatchObject({ error: { code: 'RESERVATION_EXPIRED' }, charged: false, replayed: true });

    ctx.ai.failNext();
    await crashed;
  });

  it('keys are scoped per user: alice and bob can use the same key independently', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    const a = await ctx.ask('alice', 'hello', 'shared-key');
    const b = await ctx.ask('bob', 'hello', 'shared-key');
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().requestId).not.toBe(a.json().requestId);
    expect(b.json().replayed).toBe(false);
  });

  it('requests without a key are independent and each is charged', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    await ctx.ask('alice', 'hello');
    await ctx.ask('alice', 'hello');
    expect(await ctx.usage('alice')).toMatchObject({ used: 2 });
  });
});
