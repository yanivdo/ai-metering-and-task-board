import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Config } from './config/env.js';
import type { Db } from './infrastructure/database.js';
import type { AiClient } from './infrastructure/mock-ai.js';
import { QuotaRepository } from './modules/quota/quota.repository.js';
import { QuotaService } from './modules/quota/quota.service.js';
import { UsageRepository } from './modules/usage/usage.repository.js';
import { registerUsageRoutes } from './modules/usage/usage.routes.js';
import { UsageService } from './modules/usage/usage.service.js';
import { errorHandler, StorageUnavailableError } from './shared/errors.js';
import { systemClock, type Clock } from './shared/time.js';

export interface AppDeps {
  config: Config;
  db: Db;
  ai: AiClient;
  clock?: Clock;
  /** Overrides config.quotaLimit; lets tests change the limit mid-period (#12, #13). */
  getLimit?: () => number;
  /** Reservations expired per sweeper transaction (tests use a small value). */
  sweepBatchSize?: number;
  logger?: FastifyServerOptions['logger'];
}

export interface Services {
  quota: QuotaService;
  usage: UsageService;
}

export function buildApp(deps: AppDeps): { app: FastifyInstance; services: Services } {
  const { config, db, ai } = deps;
  const clock = deps.clock ?? systemClock;

  const app = Fastify({
    logger: deps.logger ?? false,
    // Derived from the prompt limit (#38): worst case 4 UTF-8 bytes per character + 1 KB of JSON
    // around it, so every prompt the config allows fits, and nothing much larger is buffered.
    bodyLimit: config.maxPromptChars * 4 + 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
  });

  const usageRepo = new UsageRepository(db);
  const quota = new QuotaService(db, new QuotaRepository(db), usageRepo, clock, {
    periodMs: config.quotaPeriodMs,
    getLimit: deps.getLimit ?? (() => config.quotaLimit),
    sweepBatchSize: deps.sweepBatchSize,
  }, app.log);
  const usage = new UsageService(db, usageRepo, quota, ai, clock, {
    aiTimeoutMs: config.aiTimeoutMs,
    instanceId: config.instanceId,
    requestHashSecret: config.requestHashSecret,
  }, app.log);

  // If the DB connection was closed mid-request (e.g. shutdown deadline), better-sqlite3 throws a plain
  // TypeError rather than a SqliteError; report it as what it is: storage unavailable (503, #22).
  app.setErrorHandler((error, request, reply) =>
    errorHandler(db.open ? error : new StorageUnavailableError(), request, reply),
  );
  // Fail closed up front (#22): if the DB connection is gone, reject before touching anything.
  app.addHook('onRequest', async () => {
    if (!db.open) throw new StorageUnavailableError();
  });

  // Graceful shutdown (#23): close() waits for in-flight requests, but a client's keep-alive
  // connection would otherwise stay open after its response and delay shutdown for up to the
  // keep-alive timeout. While closing, tell clients to drop the connection after each response.
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
  });
  app.addHook('onSend', async (_request, reply) => {
    if (closing) reply.header('connection', 'close');
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` } });
  });

  // Liveness + DB ping. A failing DB surfaces as 503 through the error handler.
  const ping = db.prepare('SELECT 1');
  app.get('/health', async () => {
    ping.get();
    return { status: 'ok' };
  });

  registerUsageRoutes(app, usage, config.maxPromptChars);

  return { app, services: { quota, usage } };
}
