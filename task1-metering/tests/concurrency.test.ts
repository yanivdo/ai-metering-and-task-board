import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/infrastructure/database.js';
import { ledgerCounts, setupTestApp, T0 } from './helpers.js';

const run = promisify(execFile);
const workerPath = fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url));
const start = setupTestApp();

describe('concurrency (#1)', () => {
  it('30 simultaneous requests with a limit of 5: exactly 5 succeed, 25 get 429', async () => {
    const ctx = await start({ QUOTA_LIMIT: '5' });
    // Slow AI so all 30 are in flight at the same time.
    ctx.ai.complete = (prompt) => new Promise((r) => setTimeout(() => r(`ok ${prompt}`), 20));
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => ctx.ask('alice', `p${i}`)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(25);
    expect(ledgerCounts(ctx.db, 'alice', T0).counter).toEqual({ used: 5, reserved: 0 });
  });

  it('many users at once: each gets exactly their own quota', async () => {
    const ctx = await start({ QUOTA_LIMIT: '3' });
    ctx.ai.complete = (prompt) => new Promise((r) => setTimeout(() => r(`ok ${prompt}`), 10));
    const users = ['alice', 'bob', 'carol', 'dave'];
    const results = await Promise.all(
      users.flatMap((u) => Array.from({ length: 6 }, () => ctx.ask(u).then((r) => ({ u, code: r.statusCode })))),
    );
    for (const u of users) {
      expect(results.filter((r) => r.u === u && r.code === 200)).toHaveLength(3);
      expect(ledgerCounts(ctx.db, u, T0).counter).toEqual({ used: 3, reserved: 0 });
    }
  });
});

describe('multiple server instances sharing one database (#2)', () => {
  it('3 separate processes hammering the same user never exceed the limit in total', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metering-multi-'));
    const dbPath = join(dir, 'shared.db');
    try {
      openDatabase(dbPath).close(); // create the schema once up front
      const limit = 7;
      const outputs = await Promise.all(
        ['instance-a', 'instance-b', 'instance-c'].map((id) =>
          run(process.execPath, ['--import', 'tsx', workerPath, dbPath, 'alice', '10', String(limit), id], {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
          }),
        ),
      );
      const totals = outputs.map((o) => JSON.parse(o.stdout.trim().split('\n').pop()!) as { ok: number; rejected: number });
      const ok = totals.reduce((s, t) => s + t.ok, 0);
      const rejected = totals.reduce((s, t) => s + t.rejected, 0);

      expect(ok).toBe(limit);
      expect(ok + rejected).toBe(30);

      const db = openDatabase(dbPath);
      try {
        const row = db
          .prepare<[], { used: number; reserved: number }>(`SELECT SUM(used) AS used, SUM(reserved) AS reserved FROM usage_counters WHERE user_id = 'alice'`)
          .get()!;
        const succeeded = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM usage_events WHERE user_id = 'alice' AND status = 'succeeded'`).get()!;
        const instances = db.prepare<[], { n: number }>(`SELECT COUNT(DISTINCT instance_id) AS n FROM usage_events`).get()!;
        expect(row).toEqual({ used: limit, reserved: 0 });
        expect(succeeded.n).toBe(limit);
        expect(instances.n).toBeGreaterThanOrEqual(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
