/**
 * Simulates one server instance in its own OS process, sharing the DB file with other instances.
 * Usage: node --import tsx tests/fixtures/worker.ts <dbPath> <userId> <attempts> <limit> <instanceId>
 * Prints {"ok":n,"rejected":n} as the last line of stdout.
 */
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { openDatabase } from '../../src/infrastructure/database.js';
import type { AiClient } from '../../src/infrastructure/mock-ai.js';
import { QuotaExceededError } from '../../src/shared/errors.js';

const [dbPath, userId, attempts, limit, instanceId] = process.argv.slice(2);
if (!dbPath || !userId || !attempts || !limit || !instanceId) throw new Error('missing args');

// Tiny random delay so requests from different processes really interleave.
const ai: AiClient = {
  complete: (prompt) => new Promise((r) => setTimeout(() => r(`ok ${prompt}`), Math.random() * 5)),
};

const db = openDatabase(dbPath, { busyTimeoutMs: 10_000 });
const config = loadConfig({ QUOTA_LIMIT: limit, INSTANCE_ID: instanceId, AI_TIMEOUT_MS: '10000', RESERVATION_TTL_MS: '60000' });
const { services } = buildApp({ config, db, ai });

let ok = 0;
let rejected = 0;
await Promise.all(
  Array.from({ length: Number(attempts) }, async (_, i) => {
    try {
      const out = await services.usage.submit({ userId, prompt: `${instanceId}-${i}` });
      if (out.status === 'succeeded') ok++;
    } catch (err) {
      if (err instanceof QuotaExceededError) rejected++;
      else throw err;
    }
  }),
);
db.close();
console.log(JSON.stringify({ ok, rejected }));
