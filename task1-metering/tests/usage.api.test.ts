import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseOpenError, openDatabase } from '../src/infrastructure/database.js';
import { HOUR, setupTestApp, T0, type TestContext } from './helpers.js';

const start = setupTestApp();

describe('POST /v1/users/:userId/ai-requests', () => {
  it('success: 200, charged, returns the result and the updated usage', async () => {
    const ctx = await start({ QUOTA_LIMIT: '3' });
    const res = await ctx.ask('alice', 'hi there');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'succeeded',
      charged: true,
      replayed: false,
      result: 'answer to: hi there',
      usage: { userId: 'alice', used: 1, inFlight: 0, remaining: 2, limit: 3 },
    });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('AI failure: 502, not charged, failure recorded as evidence (#6)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '3' });
    ctx.ai.behavior = 'fail';
    const res = await ctx.ask('alice');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: { code: 'AI_ERROR' },
      status: 'failed',
      charged: false,
      usage: { used: 0, inFlight: 0, remaining: 3 },
    });
    expect((await ctx.events('alice')).items).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'AI_ERROR' })]);
  });

  it('AI hangs: hard timeout -> 504, credit released (#7)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1', AI_TIMEOUT_MS: '50', RESERVATION_TTL_MS: '1000' });
    ctx.ai.behavior = 'hang';
    const res = await ctx.ask('alice');
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: { code: 'AI_TIMEOUT' }, charged: false, usage: { remaining: 1, inFlight: 0 } });
    ctx.ai.behavior = 'ok';
    expect((await ctx.ask('alice')).statusCode).toBe(200); // the released credit is usable
  });

  it('quota exceeded: 429 with Retry-After = seconds until the period ends', async () => {
    const ctx = await start({ QUOTA_LIMIT: '1' });
    ctx.clock.set(T0 + HOUR / 2); // 10:30
    await ctx.ask('alice');
    const res = await ctx.ask('alice');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1800');
    expect(res.json()).toMatchObject({
      error: { code: 'QUOTA_EXCEEDED' },
      usage: { used: 1, remaining: 0, periodEnd: new Date(T0 + HOUR).toISOString() },
    });
  });

  it('X = 0: 429 without Retry-After, because waiting would not help (#27)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '0' });
    const res = await ctx.ask('alice');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED', message: expect.stringContaining('0') } });
  });

  it('prompt hashes are keyed by a secret and the user: no cross-user correlation, no guessing (#28)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    await ctx.ask('alice', 'same prompt');
    await ctx.ask('bob', 'same prompt');
    const [a] = (await ctx.events('alice')).items;
    const [b] = (await ctx.events('bob')).items;
    expect(a!.requestHash).not.toBe(b!.requestHash);
    expect(a!.requestHash).not.toBe(createHash('sha256').update('same prompt').digest('hex'));
  });

  it('prompt length counts characters (code points) consistently for validation and evidence (#32)', async () => {
    const ctx = await start({ MAX_PROMPT_CHARS: '2' });
    expect((await ctx.ask('alice', '😀😀')).statusCode).toBe(200); // 2 characters, 4 UTF-16 units
    expect((await ctx.events('alice')).items[0]).toMatchObject({ promptChars: 2 });
    expect((await ctx.ask('alice', '😀😀😀')).statusCode).toBe(400);
  });

  it('the request size limit follows MAX_PROMPT_CHARS: a 70,000-char prompt is accepted when allowed (#38)', async () => {
    const ctx = await start({ MAX_PROMPT_CHARS: '100000' });
    expect((await ctx.ask('alice', 'x'.repeat(70_000))).statusCode).toBe(200);
    expect((await ctx.ask('alice', 'x'.repeat(100_001))).statusCode).toBe(400);
  });

  it('a prompt with visible text around zero-width characters is still accepted (#39)', async () => {
    const ctx = await start();
    expect((await ctx.ask('alice', '​hi​')).statusCode).toBe(200);
  });

  it('a missing counter row at finalize rolls back (500), never records an uncounted success (#41)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    ctx.ai.behavior = 'manual';
    const pending = ctx.ask('alice');
    await ctx.ai.waitForCalls(1);
    ctx.db.prepare(`DELETE FROM usage_counters WHERE user_id = 'alice'`).run(); // simulate corruption
    ctx.ai.succeedNext();

    const res = await pending;
    expect(res.statusCode).toBe(500);
    expect(ctx.db.prepare(`SELECT status FROM usage_events`).get()).toEqual({ status: 'reserved' });

    // The sweeper still recovers it (nothing to release) instead of getting stuck on it.
    ctx.clock.advance(ctx.config.reservationTtlMs + 1);
    expect(ctx.services.quota.sweepExpired(ctx.config.reservationTtlMs)).toBe(1);
    expect(ctx.db.prepare(`SELECT status FROM usage_events`).get()).toEqual({ status: 'expired' });
  });

  it('a counter row whose reserved count was already 0 is treated like a missing row: 500, and the sweeper still recovers (#41)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    ctx.ai.behavior = 'manual';
    const pending = ctx.ask('alice');
    await ctx.ai.waitForCalls(1);
    ctx.db.prepare(`UPDATE usage_counters SET reserved = 0 WHERE user_id = 'alice'`).run(); // simulate corruption
    ctx.ai.failNext();

    const res = await pending;
    expect(res.statusCode).toBe(500); // an invariant problem, not "storage unavailable"
    ctx.clock.advance(ctx.config.reservationTtlMs + 1);
    expect(ctx.services.quota.sweepExpired(ctx.config.reservationTtlMs)).toBe(1);
    expect(ctx.db.prepare(`SELECT status FROM usage_events`).get()).toEqual({ status: 'expired' });
  });

  describe('input validation -> 400 (#16)', () => {
    const cases: Array<[string, { url?: string; payload?: unknown; headers?: Record<string, string> }]> = [
      ['userId with invalid characters', { url: '/v1/users/bad%20id!/ai-requests' }],
      ['userId longer than 64 chars', { url: `/v1/users/${'a'.repeat(65)}/ai-requests` }],
      ['missing prompt', { payload: {} }],
      ['empty prompt', { payload: { prompt: '' } }],
      ['whitespace-only prompt', { payload: { prompt: '   \n\t' } }],
      ['invisible zero-width-only prompt (#39)', { payload: { prompt: '​‌‍⁠﻿' } }],
      ['prompt longer than MAX_PROMPT_CHARS', { payload: { prompt: 'x'.repeat(101) } }],
      ['numeric prompt (no type coercion)', { payload: { prompt: 123 } }],
      ['unknown extra field', { payload: { prompt: 'hi', model: 'gpt' } }],
      ['idempotency key with spaces', { headers: { 'idempotency-key': 'has space' } }],
      ['idempotency key longer than 128', { headers: { 'idempotency-key': 'k'.repeat(129) } }],
    ];
    it.each(cases)('%s', async (_name, c) => {
      const ctx = await start({ MAX_PROMPT_CHARS: '100' });
      const res = await ctx.app.inject({
        method: 'POST',
        url: c.url ?? '/v1/users/alice/ai-requests',
        payload: (c.payload ?? { prompt: 'hi' }) as object,
        headers: c.headers ?? {},
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.ai.calls).toBe(0);
      expect(await ctx.usage('alice')).toMatchObject({ used: 0, inFlight: 0 });
    });

    it('malformed JSON body', async () => {
      const ctx = await start();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/users/alice/ai-requests',
        headers: { 'content-type': 'application/json' },
        payload: '{"prompt": ',
      });
      expect(res.statusCode).toBe(400);
    });

    it('non-JSON body (text/plain) is rejected without using a credit', async () => {
      const ctx = await start();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/users/alice/ai-requests',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });
      // Fastify parses text/plain as a string, so the schema ("body must be an object") rejects it.
      expect(res.statusCode).toBe(400);
      expect(ctx.ai.calls).toBe(0);
    });
  });
});

describe('GET /v1/users/:userId/usage', () => {
  it('unknown user: 200 with zeros, not 404 (#17)', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    const res = await ctx.app.inject({ url: '/v1/users/never-seen/usage' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: 'never-seen',
      limit: 5,
      used: 0,
      inFlight: 0,
      remaining: 5,
      periodStart: new Date(T0).toISOString(),
      periodEnd: new Date(T0 + HOUR).toISOString(),
    });
  });

  it('invalid userId -> 400', async () => {
    const ctx = await start();
    expect((await ctx.app.inject({ url: '/v1/users/bad!id/usage' })).statusCode).toBe(400);
  });
});

describe('GET /v1/users/:userId/usage/events (#24)', () => {
  async function seed(ctx: TestContext, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      ctx.clock.advance(1); // distinct timestamps
      await ctx.ask('alice', `prompt ${i}`);
    }
  }

  it('no filters: newest 50 first, with a cursor that pages to the rest without gaps or duplicates', async () => {
    const ctx = await start({ QUOTA_LIMIT: '100' });
    await seed(ctx, 55);
    const page1 = await ctx.events('alice');
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const times = page1.items.map((e) => e.createdAt as string);
    expect([...times].sort().reverse()).toEqual(times); // newest first

    // New events arriving while paging must not shift or duplicate the next page.
    await seed(ctx, 3);
    const page2 = await ctx.events('alice', `?cursor=${page1.nextCursor}`);
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((e) => e.id)).size).toBe(55);
  });

  it('items never expose the stored response body or the prompt', async () => {
    const ctx = await start();
    await ctx.ask('alice', 'secret prompt');
    const item = (await ctx.events('alice')).items[0]!;
    expect(item).not.toHaveProperty('responseBody');
    expect(JSON.stringify(item)).not.toContain('secret prompt');
    expect(item).toMatchObject({ promptChars: 13, requestHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('custom limit works', async () => {
    const ctx = await start();
    await seed(ctx, 3);
    const res = await ctx.events('alice', '?limit=2');
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).not.toBeNull();
  });

  it.each(['0', '101', 'abc', '-1', '1.5'])('limit=%s -> 400', async (limit) => {
    const ctx = await start();
    expect((await ctx.app.inject({ url: `/v1/users/alice/usage/events?limit=${limit}` })).statusCode).toBe(400);
  });

  it('malformed or tampered cursor -> 400', async () => {
    const ctx = await start();
    for (const cursor of ['not-base64!!', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('["x","id"]').toString('base64url')]) {
      expect((await ctx.app.inject({ url: `/v1/users/alice/usage/events?cursor=${encodeURIComponent(cursor)}` })).statusCode).toBe(400);
    }
  });

  it('unknown user: 200 with an empty list', async () => {
    const ctx = await start();
    expect(await ctx.events('nobody')).toEqual({ items: [], nextCursor: null });
  });
});

describe('evidence ledger is tamper-proof (#18)', () => {
  it('rejects DELETE, illegal status changes, and edits to evidence columns', async () => {
    const ctx = await start();
    await ctx.ask('alice');
    const db = ctx.db;
    expect(() => db.prepare('DELETE FROM usage_events').run()).toThrow(/append-only/);
    expect(() => db.prepare(`UPDATE usage_events SET status = 'failed'`).run()).toThrow(/illegal update/);
    expect(() => db.prepare(`UPDATE usage_events SET user_id = 'mallory'`).run()).toThrow(/illegal update/);
    expect(() => db.prepare(`UPDATE usage_events SET created_at = 0`).run()).toThrow(/illegal update/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 1 });
  });
});

describe('storage failure -> fail closed with 503 (#22)', () => {
  it('rejects AI requests (no credit without evidence) and reports unhealthy', async () => {
    const ctx = await start();
    expect((await ctx.app.inject({ url: '/health' })).statusCode).toBe(200);
    ctx.db.close(); // simulate the database becoming unavailable
    const res = await ctx.ask('alice');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } });
    expect(ctx.ai.calls).toBe(0);
    expect((await ctx.app.inject({ url: '/health' })).statusCode).toBe(503);
  });

  it('DB closed while the AI call is running: finalize fails with 503 (not 500), as documented', async () => {
    const ctx = await start();
    ctx.ai.behavior = 'manual';
    const pending = ctx.ask('alice');
    await ctx.ai.waitForCalls(1);
    ctx.db.close(); // e.g. the shutdown deadline closed the DB mid-request
    ctx.ai.succeedNext();
    const res = await pending;
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } });
  });
});

describe('database cannot be opened -> clear error (#44)', () => {
  it('throws DatabaseOpenError naming the path when the path is a directory or not a database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metering-open-'));
    try {
      expect(() => openDatabase(dir)).toThrow(DatabaseOpenError); // path is a directory
      const notDb = join(dir, 'not-a-db.db');
      writeFileSync(notDb, 'this is plain text, not SQLite '.repeat(10));
      expect(() => openDatabase(notDb)).toThrow(/cannot open database at ".*not-a-db\.db"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('graceful shutdown (#23)', () => {
  it('close() waits for an in-flight request to finish and record its evidence', async () => {
    const ctx = await start();
    ctx.ai.behavior = 'manual';
    const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const response = fetch(`${address}/v1/users/alice/ai-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    await ctx.ai.waitForCalls(1);

    let closed = false;
    const closing = ctx.app.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false); // still waiting for the in-flight request

    ctx.ai.succeedNext();
    expect((await response).status).toBe(200);
    await closing;
    expect(closed).toBe(true);
    expect(ctx.db.prepare(`SELECT status FROM usage_events`).get()).toEqual({ status: 'succeeded' });
  });
});

describe('routing', () => {
  it('unknown route -> 404 JSON', async () => {
    const ctx = await start();
    const res = await ctx.app.inject({ url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
