import { describe, expect, it } from 'vitest';
import { createShutdown, type ShutdownDeps } from '../src/shutdown.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function setup(close: ShutdownDeps['close'], timeoutMs = 1000) {
  const exits: number[] = [];
  let cleanups = 0;
  const shutdown = createShutdown({
    close,
    cleanup: () => {
      cleanups++;
    },
    exit: (code) => exits.push(code),
    log: silentLog,
    timeoutMs,
  });
  return { shutdown, exits, cleanups: () => cleanups };
}

describe('graceful shutdown exit codes and deadline (#36, #37)', () => {
  it('normal stop (SIGINT/SIGTERM) exits 0 after closing and cleaning up', async () => {
    const s = setup(async () => {});
    await s.shutdown('SIGTERM', 0);
    expect(s.exits).toEqual([0]);
    expect(s.cleanups()).toBe(1);
  });

  it('after a crash it exits 1, so a supervisor sees the failure (#36)', async () => {
    const s = setup(async () => {});
    await s.shutdown('uncaughtException', 1);
    expect(s.exits).toEqual([1]);
  });

  it('if closing hangs, it force-exits with 1 after the deadline (#37)', async () => {
    const s = setup(() => new Promise<void>(() => {}), 50); // close() never finishes
    void s.shutdown('SIGTERM', 0);
    await new Promise((r) => setTimeout(r, 120));
    expect(s.exits).toEqual([1]);
    expect(s.cleanups()).toBe(1);
  });

  it('if closing throws, it exits 1', async () => {
    const s = setup(async () => {
      throw new Error('close failed');
    });
    await s.shutdown('SIGTERM', 0);
    expect(s.exits).toEqual([1]);
  });

  it('a second signal while shutting down is ignored', async () => {
    const s = setup(async () => {});
    await Promise.all([s.shutdown('SIGINT', 0), s.shutdown('SIGTERM', 0)]);
    expect(s.exits).toEqual([0]);
    expect(s.cleanups()).toBe(1);
  });
});
