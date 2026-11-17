import { fileURLToPath } from 'node:url';
import { buildServer } from './app';
import { ConfigError, loadServerConfig, type ServerConfig } from './config';
import { seedTasks } from './seed';
import { startSimulator } from './simulator';
import { TaskStore } from './taskStore';

let config: ServerConfig;
try {
  config = loadServerConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`Invalid configuration: ${err.message}`);
  process.exit(1);
}

const staticDir = fileURLToPath(new URL('../dist', import.meta.url));
const store = new TaskStore({ seed: seedTasks() });
const app = buildServer({ store, staticDir, logger: { level: config.logLevel } });
const stopSimulator = config.simulator
  ? startSimulator(store, { intervalMs: config.simIntervalMs, minTasks: config.simMinTasks, maxTasks: config.simMaxTasks })
  : () => {};

const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

/** Graceful shutdown: stop the simulator, close SSE streams and the server; exit 1 after a crash or a hang. */
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ reason }, 'shutting down');
  stopSimulator();
  const deadline = setTimeout(() => {
    app.log.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, 'error while closing');
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaught exception; shutting down');
  void shutdown('uncaughtException', 1);
});

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ simulator: config.simulator, intervalMs: config.simIntervalMs }, `task board ready at ${address}`);
} catch (err) {
  app.log.error({ err }, 'failed to start'); // e.g. port already in use
  stopSimulator();
  process.exit(1);
}
