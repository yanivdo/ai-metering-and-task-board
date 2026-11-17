import type { Logger } from './shared/logger.js';

export interface ShutdownDeps {
  /** Stops accepting connections and waits for in-flight requests (Fastify app.close()). */
  close: () => Promise<void>;
  /** Releases resources (timers, DB). Must be safe to call more than once. */
  cleanup: () => void;
  /** process.exit in production; a recorder in tests. */
  exit: (code: number) => void;
  log: Logger;
  timeoutMs: number;
}

/**
 * Returns an idempotent shutdown function.
 * - Normal stop (SIGINT/SIGTERM): exit code 0.
 * - After a crash: exit code 1, so a supervisor (Docker, systemd, Kubernetes) sees a failure (#36).
 * - If closing hangs past the deadline: force exit with code 1 (#37).
 * - If closing itself throws: exit code 1.
 */
export function createShutdown(deps: ShutdownDeps): (reason: string, exitCode: number) => Promise<void> {
  let started = false;

  return async (reason, exitCode) => {
    if (started) return;
    started = true;
    deps.log.info({ reason }, 'shutting down: waiting for in-flight requests');

    const deadline = setTimeout(() => {
      deps.log.error({ timeoutMs: deps.timeoutMs }, 'shutdown timed out; forcing exit');
      deps.cleanup();
      deps.exit(1);
    }, deps.timeoutMs);
    deadline.unref();

    let code = exitCode;
    try {
      await deps.close();
    } catch (err) {
      deps.log.error({ err }, 'error while closing');
      code = 1;
    } finally {
      clearTimeout(deadline);
      deps.cleanup();
    }
    deps.exit(code);
  };
}
