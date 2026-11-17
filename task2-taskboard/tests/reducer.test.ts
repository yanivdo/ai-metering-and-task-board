import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_LIMIT,
  applyLocalChanges,
  applyLocalCreate,
  applyLocalDelete,
  applyServerEvents,
  canRebase,
  initialBoardState,
  resolveCreate,
  resolveDelete,
  resolveUpdate,
  type BoardState,
} from '../src/state/reducer';
import type { ServerEvent } from '../shared/types';
import { EventFactory, makeTask } from './fixtures';

const ME = 'me';
const apply = (s: BoardState, ...events: ServerEvent[]) => applyServerEvents(s, events, ME, 1000);

function loaded(tasks = [makeTask()]) {
  const ev = new EventFactory();
  const state = apply(initialBoardState(), ev.snapshot(tasks));
  return { ev, state, task: tasks[0]! };
}

describe('server events', () => {
  it('a snapshot loads every task and the stream position', () => {
    const a = makeTask();
    const b = makeTask();
    const ev = new EventFactory();
    ev.seq = 7;
    const s = apply(initialBoardState(), ev.snapshot([a, b]));
    expect(Object.keys(s.tasks)).toEqual([a.id, b.id]);
    expect(s).toMatchObject({ epoch: ev.epoch, seq: 7 });
  });

  it('applies creates and updates from the server and logs them as "server"', () => {
    const { ev, state, task } = loaded();
    const extra = makeTask();
    const s = apply(state, ev.created(extra), ev.updated({ ...task, status: 'done', version: 2 }, ['status']));
    expect(s.tasks[extra.id]).toEqual(extra);
    expect(s.tasks[task.id]?.status).toBe('done');
    expect(s.activity[0]).toMatchObject({ actor: 'server', kind: 'updated', detail: 'status: To do → Done' });
  });

  it('ignores duplicate and out-of-order events (#4)', () => {
    const { ev, state, task } = loaded();
    const v2 = ev.updated({ ...task, status: 'in_progress', version: 2 }, ['status']);
    const v3 = ev.updated({ ...task, status: 'done', version: 3 }, ['status']);
    const s = apply(state, v3, v2, v3); // v2 arrives late, v3 twice
    expect(s.tasks[task.id]).toMatchObject({ status: 'done', version: 3 });
    expect(s.activity).toHaveLength(1);
  });

  it('a stale version is ignored even with a new seq (#4)', () => {
    const { ev, state, task } = loaded([makeTask({ version: 5 })]);
    const s = apply(state, ev.updated({ ...task, status: 'done', version: 4 }, ['status']));
    expect(s.tasks[task.id]?.status).toBe('todo');
  });

  it('the echo of your own change is applied silently: no second activity entry (#5)', () => {
    const { ev, state, task } = loaded();
    let s = applyLocalChanges(state, task.id, { status: 'done' }, 1000);
    expect(s.activity).toHaveLength(1);
    s = apply(s, ev.updated({ ...task, status: 'done', version: 2 }, ['status'], `client:${ME}`));
    expect(s.confirmed[task.id]?.version).toBe(2);
    expect(s.activity).toHaveLength(1);
  });

  it('changes by another browser are logged as "another user"', () => {
    const { ev, state, task } = loaded();
    const s = apply(state, ev.updated({ ...task, priority: 'high', version: 2 }, ['priority'], 'client:other-tab'));
    expect(s.activity[0]).toMatchObject({ actor: 'another user' });
  });

  it('an update that arrives after the delete cannot bring the task back (#6)', () => {
    const { ev, state, task } = loaded();
    const lateUpdate = ev.updated({ ...task, status: 'done', version: 2 }, ['status']);
    const del = ev.deleted({ ...task, version: 2 });
    const s = apply(state, del, { ...lateUpdate, seq: ev.seq + 1 });
    expect(s.tasks[task.id]).toBeUndefined();
    expect(s.tombstones[task.id]).toBe(3);
  });

  it('a snapshot from a restarted server replaces everything; events from the old run are ignored (#9)', () => {
    const { ev, state, task } = loaded();
    const s1 = apply(state, ev.deleted(task));
    const fresh = makeTask();
    const restarted = new EventFactory('epoch-2');
    const s2 = apply(s1, restarted.snapshot([fresh]));
    expect(Object.keys(s2.tasks)).toEqual([fresh.id]);
    expect(s2.tombstones).toEqual({}); // history of the old run is gone
    const s3 = apply(s2, ev.created(makeTask())); // late event from the old server run
    expect(Object.keys(s3.tasks)).toEqual([fresh.id]);
  });

  it('a snapshot keeps your unsent edits and your in-flight create and delete (#8)', () => {
    const a = makeTask();
    const b = makeTask();
    const { ev, state } = loaded([a, b]);
    let s = applyLocalChanges(state, a.id, { title: 'mine' }, 1000);
    s = applyLocalDelete(s, b.id, 1000);
    s = applyLocalCreate(s, { id: 'new', title: 'new', assignee: null, status: 'todo', priority: 'low' }, 1000);
    s = apply(s, ev.snapshot([{ ...a, priority: 'high', version: 2 }, b]));
    expect(s.tasks[a.id]).toMatchObject({ title: 'mine', priority: 'high' });
    expect(s.tasks[b.id]).toBeUndefined();
    expect(s.tasks.new).toBeDefined();
  });

  it('a burst of 100 events becomes ONE state change with the right result (#17)', () => {
    const { ev, state, task } = loaded();
    const events = Array.from({ length: 100 }, (_, i) => ev.updated({ ...task, priority: i % 2 ? 'high' : 'low', version: i + 2 }, ['priority']));
    const s = applyServerEvents(state, events, ME, 1000);
    expect(s.tasks[task.id]).toMatchObject({ version: 101, priority: 'high' }); // last event: i = 99 (odd) -> 'high'
    expect(s.seq).toBe(100);
  });

  it('the activity log keeps only the newest entries (#18)', () => {
    const { ev, state, task } = loaded();
    const events = Array.from({ length: ACTIVITY_LIMIT + 20 }, (_, i) => ev.updated({ ...task, version: i + 2 }, ['status']));
    const s = applyServerEvents(state, events, ME, 1000);
    expect(s.activity).toHaveLength(ACTIVITY_LIMIT);
    expect(s.activity[0]!.id).toBeGreaterThan(s.activity[1]!.id); // newest first
  });
});

describe('your own edits (optimistic)', () => {
  it('show immediately while the server copy stays unchanged', () => {
    const { state, task } = loaded();
    const s = applyLocalChanges(state, task.id, { status: 'done' }, 1000);
    expect(s.tasks[task.id]?.status).toBe('done');
    expect(s.confirmed[task.id]?.status).toBe('todo');
    expect(s.pending[task.id]).toEqual({ status: 'done' });
  });

  it('setting a field back to the server value is no longer a pending change', () => {
    const { state, task } = loaded();
    let s = applyLocalChanges(state, task.id, { status: 'done' }, 1000);
    s = applyLocalChanges(s, task.id, { status: 'todo' }, 1000);
    expect(s.pending[task.id]).toBeUndefined();
  });

  it('a live server change to another field is shown together with your unsent edit (#11)', () => {
    const { ev, state, task } = loaded();
    let s = applyLocalChanges(state, task.id, { title: 'my draft' }, 1000);
    s = apply(s, ev.updated({ ...task, priority: 'high', version: 2 }, ['priority']));
    expect(s.tasks[task.id]).toMatchObject({ title: 'my draft', priority: 'high' });
  });

  it('ok: the server copy is updated and only the fields that were sent stop being pending', () => {
    const { state, task } = loaded();
    let s = applyLocalChanges(state, task.id, { status: 'done' }, 1000);
    s = applyLocalChanges(s, task.id, { priority: 'high' }, 1000); // edited after the request was sent
    s = resolveUpdate(s, task.id, { status: 'done' }, { kind: 'ok', task: { ...task, status: 'done', version: 2 } }, 1000);
    expect(s.pending[task.id]).toEqual({ priority: 'high' });
    expect(s.tasks[task.id]).toMatchObject({ status: 'done', priority: 'high', version: 2 });
  });

  it('conflict: the server value wins, your change is undone and logged (#3)', () => {
    const { state, task } = loaded();
    let s = applyLocalChanges(state, task.id, { status: 'done' }, 1000);
    s = resolveUpdate(s, task.id, { status: 'done' }, { kind: 'conflict', current: { ...task, status: 'in_progress', version: 2 } }, 1000);
    expect(s.tasks[task.id]).toMatchObject({ status: 'in_progress', version: 2 });
    expect(s.pending[task.id]).toBeUndefined();
    expect(s.activity[0]).toMatchObject({ kind: 'conflict' });
  });

  it('network failure: your change is undone and logged (#12)', () => {
    const { state, task } = loaded();
    let s = applyLocalChanges(state, task.id, { status: 'done' }, 1000);
    s = resolveUpdate(s, task.id, { status: 'done' }, { kind: 'failed', message: 'offline' }, 1000);
    expect(s.tasks[task.id]?.status).toBe('todo');
    expect(s.activity[0]).toMatchObject({ kind: 'error', detail: expect.stringContaining('offline') });
  });

  it('not found: the task was deleted meanwhile, so it is removed', () => {
    const { state, task } = loaded();
    let s = applyLocalChanges(state, task.id, { status: 'done' }, 1000);
    s = resolveUpdate(s, task.id, { status: 'done' }, { kind: 'not_found' }, 1000);
    expect(s.tasks[task.id]).toBeUndefined();
    expect(s.tombstones[task.id]).toBeDefined();
  });

  it('canRebase: yes if the server changed other fields, no if it changed one of yours (#3)', () => {
    const base = makeTask();
    expect(canRebase(base, { ...base, priority: 'high', version: 2 }, { status: 'done' })).toBe(true);
    expect(canRebase(base, { ...base, status: 'in_progress', version: 2 }, { status: 'done' })).toBe(false);
  });
});

describe('your own creates and deletes', () => {
  const input = { id: 'new-1', title: 'Fresh', assignee: null, status: 'todo', priority: 'low' } as const;

  it('create shows immediately (version 0), then becomes the server copy', () => {
    let s = applyLocalCreate(loaded().state, input, 1000);
    expect(s.tasks[input.id]).toMatchObject({ title: 'Fresh', version: 0 });
    s = resolveCreate(s, input.id, { kind: 'ok', task: { ...input, version: 1, createdAt: 1, updatedAt: 1 } }, 1000);
    expect(s.tasks[input.id]?.version).toBe(1);
  });

  it('a failed create is removed again and logged', () => {
    let s = applyLocalCreate(loaded().state, input, 1000);
    s = resolveCreate(s, input.id, { kind: 'failed', message: 'offline' }, 1000);
    expect(s.tasks[input.id]).toBeUndefined();
    expect(s.activity[0]).toMatchObject({ kind: 'error' });
  });

  it('delete hides the task at once and ignores server updates for it while in flight', () => {
    const { ev, state, task } = loaded();
    let s = applyLocalDelete(state, task.id, 1000);
    expect(s.tasks[task.id]).toBeUndefined();
    s = apply(s, ev.updated({ ...task, status: 'done', version: 2 }, ['status']));
    expect(s.tasks[task.id]).toBeUndefined();
    s = resolveDelete(s, task, { kind: 'ok' }, 1000);
    expect(s.tombstones[task.id]).toBe(2);
  });

  it('a failed delete restores the task (#12)', () => {
    const { state, task } = loaded();
    let s = applyLocalDelete(state, task.id, 1000);
    s = resolveDelete(s, task, { kind: 'failed', message: 'offline' }, 1000);
    expect(s.tasks[task.id]).toEqual(task);
    expect(s.tombstones[task.id]).toBeUndefined();
  });
});
