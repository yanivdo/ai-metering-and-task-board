import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server/app';
import { ConfigError, loadServerConfig } from '../server/config';
import { initialEvents } from '../server/events';
import { simulateStep } from '../server/simulator';
import { TaskStore } from '../server/taskStore';
import type { NewTask, ServerEvent, Task } from '../shared/types';
import { seededRandom } from './fixtures';

const newTask = (over: Partial<NewTask> = {}): NewTask => ({
  id: crypto.randomUUID(),
  title: 'Write tests',
  assignee: 'Alice',
  status: 'todo',
  priority: 'medium',
  ...over,
});

function collect(store: TaskStore): ServerEvent[] {
  const events: ServerEvent[] = [];
  store.subscribe((e) => events.push(e));
  return events;
}

describe('TaskStore', () => {
  it('create: version 1, emits task.created with seq and epoch', () => {
    const store = new TaskStore();
    const events = collect(store);
    const result = store.create(newTask(), 'client:a');
    expect(result.kind).toBe('created');
    expect(events).toEqual([expect.objectContaining({ type: 'task.created', seq: 1, epoch: store.epoch, source: 'client:a' })]);
  });

  it('create is safe to retry: same id + same content returns the existing task, no new event (#15)', () => {
    const store = new TaskStore();
    const input = newTask();
    store.create(input, 'client:a');
    const events = collect(store);
    expect(store.create(input, 'client:a').kind).toBe('exists');
    expect(events).toHaveLength(0);
  });

  it('create with an existing id but different content, or a deleted id, is a conflict', () => {
    const store = new TaskStore();
    const input = newTask();
    store.create(input, 'client:a');
    expect(store.create({ ...input, title: 'Other' }, 'client:a').kind).toBe('conflict');
    store.delete(input.id, 'client:a');
    expect(store.create(input, 'client:a').kind).toBe('conflict'); // never resurrect a deleted id
  });

  it('update bumps the version, records which fields changed, and rejects a stale baseVersion', () => {
    const store = new TaskStore();
    const { id } = newTask();
    store.create(newTask({ id }), 'client:a');
    const events = collect(store);

    const updated = store.update(id, { status: 'done', title: 'Write tests' }, 'client:a', 1);
    expect(updated).toMatchObject({ kind: 'updated', task: { version: 2, status: 'done' } });
    expect(events[0]).toMatchObject({ type: 'task.updated', changed: ['status'] }); // title was equal: not "changed"

    expect(store.update(id, { status: 'todo' }, 'client:b', 1)).toMatchObject({ kind: 'conflict', current: { version: 2 } });
    expect(store.update('missing', { status: 'todo' }, 'client:b', 1).kind).toBe('not_found');
  });

  it('an update that changes nothing creates no version and no event', () => {
    const store = new TaskStore();
    const { id } = newTask();
    store.create(newTask({ id, status: 'todo' }), 'client:a');
    const events = collect(store);
    expect(store.update(id, { status: 'todo' }, 'client:a', 1)).toMatchObject({ kind: 'unchanged', task: { version: 1 } });
    expect(events).toHaveLength(0);
  });

  it('delete is idempotent and the delete event carries a version above the last one (#16)', () => {
    const store = new TaskStore();
    const { id } = newTask();
    store.create(newTask({ id }), 'client:a');
    const events = collect(store);
    expect(store.delete(id, 'client:a')).toBe(true);
    expect(store.delete(id, 'client:a')).toBe(false);
    expect(events).toEqual([expect.objectContaining({ type: 'task.deleted', id, version: 2 })]);
  });

  it('remembers only the most recent 10,000 deleted ids, so memory stays bounded', () => {
    const store = new TaskStore({ bufferSize: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 10_001; i++) {
      const input = newTask();
      ids.push(input.id);
      store.create(input, 'simulator');
      store.delete(input.id, 'simulator');
    }
    expect(store.create(newTask({ id: ids[0]! }), 'simulator').kind).toBe('created'); // oldest forgotten
    expect(store.create(newTask({ id: ids.at(-1)! }), 'simulator').kind).toBe('conflict'); // recent still blocked
  });

  it('eventsSince replays missed events, and returns null when they already left the buffer', () => {
    const store = new TaskStore({ bufferSize: 3 });
    for (let i = 0; i < 5; i++) store.create(newTask(), 'simulator'); // seq 1..5, buffer keeps 3..5
    expect(store.eventsSince(5)).toEqual([]);
    expect(store.eventsSince(3)?.map((e) => e.seq)).toEqual([4, 5]);
    expect(store.eventsSince(2)?.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(store.eventsSince(1)).toBeNull(); // event 2 is gone: needs a snapshot
    expect(store.eventsSince(99)).toBeNull(); // from the future: not this server
  });
});

describe('initialEvents for a (re)connecting client (#7, #8, #9)', () => {
  it('no Last-Event-ID: snapshot', () => {
    const store = new TaskStore();
    expect(initialEvents(store, undefined)).toEqual([expect.objectContaining({ type: 'snapshot' })]);
  });

  it('same server, recent id: only the missed events', () => {
    const store = new TaskStore();
    store.create(newTask(), 'simulator');
    store.create(newTask(), 'simulator');
    expect(initialEvents(store, `${store.epoch}:1`).map((e) => e.seq)).toEqual([2]);
  });

  it('id from a previous server run (different epoch) or malformed: snapshot', () => {
    const store = new TaskStore();
    store.create(newTask(), 'simulator');
    expect(initialEvents(store, 'old-epoch:1')[0]?.type).toBe('snapshot');
    expect(initialEvents(store, 'garbage')[0]?.type).toBe('snapshot');
  });
});

describe('REST API', () => {
  let app: FastifyInstance;
  let store: TaskStore;
  afterEach(async () => {
    await app?.close();
  });

  async function setup(): Promise<void> {
    store = new TaskStore();
    app = buildServer({ store });
    await app.ready();
  }

  const post = (body: unknown, clientId = 'tab-1') =>
    app.inject({ method: 'POST', url: '/api/tasks', payload: body as object, headers: { 'x-client-id': clientId } });

  it('POST creates (201) and a retry returns the same task (200)', async () => {
    await setup();
    const body = newTask({ title: '  padded title  ' });
    const first = await post(body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ title: 'padded title', version: 1 }); // trimmed
    expect((await post(body)).statusCode).toBe(200);
  });

  it.each([
    ['empty title', { title: '' }],
    ['whitespace-only title', { title: '   ' }],
    ['invisible-only title', { title: '​​' }],
    ['title too long', { title: 'x'.repeat(201) }],
    ['numeric title (no coercion)', { title: 123 }],
    ['unknown assignee', { assignee: 'Mallory' }],
    ['invalid status', { status: 'blocked' }],
    ['invalid id', { id: 'not-a-uuid' }],
    ['extra field', { color: 'red' }],
  ])('POST rejects %s with 400 (#14)', async (_name, over) => {
    await setup();
    const res = await post({ ...newTask(), ...over });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(store.size).toBe(0);
  });

  it('PATCH: 200 with the new version; 409 with the current task when stale; 404 when deleted', async () => {
    await setup();
    const { id } = (await post(newTask())).json() as Task;
    const ok = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { changes: { status: 'done' }, baseVersion: 1 } });
    expect(ok.json()).toMatchObject({ version: 2, status: 'done' });

    const stale = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { changes: { status: 'todo' }, baseVersion: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' }, current: { version: 2, status: 'done' } });

    await app.inject({ method: 'DELETE', url: `/api/tasks/${id}` });
    const gone = await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload: { changes: { status: 'todo' }, baseVersion: 3 } });
    expect(gone.statusCode).toBe(404);
  });

  it('PATCH rejects empty changes, unknown fields and a missing baseVersion', async () => {
    await setup();
    const { id } = (await post(newTask())).json() as Task;
    for (const payload of [{ changes: {}, baseVersion: 1 }, { changes: { color: 'red' }, baseVersion: 1 }, { changes: { status: 'done' } }]) {
      expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload })).statusCode).toBe(400);
    }
  });

  it('DELETE is 204 even when the task is already gone (#16)', async () => {
    await setup();
    const { id } = (await post(newTask())).json() as Task;
    expect((await app.inject({ method: 'DELETE', url: `/api/tasks/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/tasks/${id}` })).statusCode).toBe(204);
  });

  it('events record which browser made the change (for "you" vs "another user")', async () => {
    await setup();
    const events = collect(store);
    await post(newTask(), 'tab-42');
    expect(events[0]).toMatchObject({ source: 'client:tab-42' });
  });
});

describe('SSE stream on a real port', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Reads SSE messages from a fetch response until `count` data messages have arrived. */
  async function readEvents(res: Response, count: number): Promise<ServerEvent[]> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: ServerEvent[] = [];
    let buffered = '';
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const messages = buffered.split('\n\n');
      buffered = messages.pop() ?? '';
      for (const msg of messages) {
        const data = msg.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)) as ServerEvent);
      }
    }
    await reader.cancel();
    return events;
  }

  it('sends a snapshot first, then live events; resumes with Last-Event-ID; closes cleanly on shutdown', async () => {
    const store = new TaskStore();
    store.create(newTask({ title: 'existing' }), 'simulator');
    app = buildServer({ store });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });

    const live = await fetch(`${base}/api/events`);
    expect(live.headers.get('content-type')).toContain('text/event-stream');
    const pending = readEvents(live, 2);
    await new Promise((r) => setTimeout(r, 50));
    store.create(newTask({ title: 'new one' }), 'simulator');
    const [snapshot, created] = await pending;
    expect(snapshot).toMatchObject({ type: 'snapshot', seq: 1, tasks: [expect.objectContaining({ title: 'existing' })] });
    expect(created).toMatchObject({ type: 'task.created', seq: 2, task: { title: 'new one' } });

    // Reconnect after missing event 2: only event 2 is replayed, no snapshot.
    const resumed = await fetch(`${base}/api/events`, { headers: { 'last-event-id': `${store.epoch}:1` } });
    expect((await readEvents(resumed, 1))[0]).toMatchObject({ type: 'task.created', seq: 2 });

    // An open stream must not block shutdown.
    const open = await fetch(`${base}/api/events`);
    void readEvents(open, 99).catch(() => []);
    const started = Date.now();
    await app.close();
    app = undefined;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('SSE slow-client limit (#23, #29)', () => {
  it('a snapshot larger than the limit is still delivered: the limit applies to live events piling up', async () => {
    const store = new TaskStore();
    for (let i = 0; i < 50; i++) store.create(newTask({ title: 'x'.repeat(200) }), 'simulator');
    const app = buildServer({ store, stream: { maxBufferedBytes: 2_000 } }); // the snapshot is ~15 KB
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' });
      const res = await fetch(`${base}/api/events`);
      const reader = res.body!.getReader();
      let text = '';
      while (!text.includes('"type":"snapshot"') || !text.endsWith('\n\n')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      await reader.cancel();
      const snapshot = JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as ServerEvent;
      expect(snapshot).toMatchObject({ type: 'snapshot' });
      expect(snapshot.type === 'snapshot' && snapshot.tasks).toHaveLength(50);
    } finally {
      await app.close();
    }
  });
});

describe('simulator (#22)', () => {
  it('an empty board grows back up to the minimum, one task per step', () => {
    const store = new TaskStore();
    const opts = { intervalMs: 1000, minTasks: 2, maxTasks: 6, random: seededRandom(1) };
    simulateStep(store, opts);
    simulateStep(store, opts);
    expect(store.size).toBe(2);
  });

  it('once within bounds, the task count never leaves them, and every update is a real change', () => {
    const store = new TaskStore();
    for (let i = 0; i < 3; i++) store.create(newTask(), 'simulator');
    const events = collect(store);
    const opts = { intervalMs: 1000, minTasks: 2, maxTasks: 6, random: seededRandom(7) };
    for (let i = 0; i < 500; i++) {
      simulateStep(store, opts);
      expect(store.size).toBeGreaterThanOrEqual(2);
      expect(store.size).toBeLessThanOrEqual(6);
    }
    const updates = events.filter((e) => e.type === 'task.updated');
    expect(updates.length).toBeGreaterThan(100);
    for (const u of updates) if (u.type === 'task.updated') expect(u.changed.length).toBe(1);
  });
});

describe('server config', () => {
  it.each([
    [{ PORT: 'abc' }],
    [{ SIMULATOR: 'maybe' }],
    [{ SIM_INTERVAL_MS: '3000000000' }],
    [{ SIM_MIN_TASKS: '5', SIM_MAX_TASKS: '5' }],
    [{ LOG_LEVEL: 'verbose' }],
  ])('rejects %o', (env) => {
    expect(() => loadServerConfig(env)).toThrow(ConfigError);
  });

  it('has sensible defaults', () => {
    expect(loadServerConfig({})).toMatchObject({ port: 4000, simulator: true, simIntervalMs: 4000, logLevel: 'info' });
  });
});
