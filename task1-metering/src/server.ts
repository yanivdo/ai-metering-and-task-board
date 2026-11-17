import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { DatabaseOpenError, openDatabase } from './infrastructure/database.js';
import { MockAiClient } from './infrastructure/mock-ai.js';
import { createShutdown } from './shutdown.js';

/** Startup problems the operator can fix: print one clear line instead of a stack trace (#15, #43, #44). */
function startOrExit<T>(step: () => T): T {
  try {
    return step();
  } catch (err) {
    if (err instanceof ConfigError) console.error(`Invalid configuration: ${err.message}`);
    else if (err instanceof DatabaseOpenError) console.error(`Startup failed: ${err.message}`);
    else throw err;
    process.exit(1);
  }
}

const config = startOrExit(() => loadConfig());
const db = startOrExit(() => openDatabase(config.dbPath, { synchronous: config.dbSynchronous }));
const ai = new MockAiClient({
  minDelayMs: config.aiMinDelayMs,
  maxDelayMs: config.aiMaxDelayMs,
  failureRate: config.aiFailureRate,
});
const { app, services } = buildApp({ config, db, ai, logger: { level: config.logLevel } });

/** Crash recovery: expire reservations abandoned by a crashed request/instance and release their credits. */
function sweep(): void {
  try {
    const expired = services.quota.sweepExpired(config.reservationTtlMs);
    if (expired > 0) app.log.warn({ expired }, 'sweeper expired stale reservations and released their credits');
  } catch (err) {
    app.log.error({ err }, 'sweeper failed; will retry on next interval');
  }
}

sweep(); // recover anything left by a previous crash before taking traffic
const sweepTimer = setInterval(sweep, config.sweepIntervalMs);
sweepTimer.unref(); // the timer alone never keeps the process alive

/** Releases resources. Safe to call more than once. */
function cleanup(): void {
  clearInterval(sweepTimer);
  if (db.open) db.close();
}

const shutdown = createShutdown({
  close: () => app.close(), // stops accepting connections and waits for in-flight requests
  cleanup,
  exit: (code) => process.exit(code),
  log: app.log,
  timeoutMs: config.shutdownTimeoutMs,
});
process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
// Never fail silently. After an uncaught exception the process state is unknown: shut down and exit 1 (#36).
process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaught exception; shutting down');
  void shutdown('uncaughtException', 1);
});

if (config.usingDefaultHashSecret) {
  app.log.warn('REQUEST_HASH_SECRET is not set; using the local development default (set it in production)');
}

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      quotaLimit: config.quotaLimit,
      quotaPeriodSeconds: config.quotaPeriodMs / 1000,
      aiFailureRate: config.aiFailureRate,
      aiTimeoutMs: config.aiTimeoutMs,
      dbPath: config.dbPath,
    },
    'metering service ready',
  );
} catch (err) {
  app.log.error({ err }, 'failed to start'); // e.g. port already in use
  cleanup();
  process.exit(1);
}
