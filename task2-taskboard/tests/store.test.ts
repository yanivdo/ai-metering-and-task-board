import { describe, expect, it } from 'vitest';
import { createBoardStore } from '../src/state/store';
import type { Task } from '../shared/types';
import { EventFactory, FakeApi, flush, makeTask } from './fixtures';

function setup(tasks: Task[] = [makeTask()]) {
  const api = new FakeApi();
  let ids = 0;
  const store = createBoardStore({ api, clientId: 'me', now: () => 1000, newId: () => `new-${++ids}` });
  const ev = new EventFactory();
  store.getState().receive([ev.snapshot(tasks)]);
  return { api, store, ev, task: tasks[0]! };
}

describe('editing', () => {
  it('shows the edit immediately and sends only the changes with the base version', () => {
    const { api, store, task } = setup();
    store.getState().updateTask(task.id, { status: 'done' });
    expect(store.getState().tasks[task.id]?.status).toBe('done');
    const call = api.next('update');
    expect(call).toMatchObject({ id: task.id, changes: { status: 'done' }, baseVersion: 1 });
  });

  it('rapid edits: one request at a time, later edits combined and sent with the new version (#13)', async () => {
    const { api, store, task } = setup();
    store.getState().updateTask(task.id, { status: 'in_progress' });
    store.getState().updateTask(task.id, { priority: 'high' });
    store.getState().updateTask(task.id, { status: 'done' });
    const first = api.next('update');
    expect(api.calls).toHaveLength(0); // the others wait for the first answer
    first.resolve({ ok: true, value: { ...task, status: 'in_progress', version: 2 } });
    await flush();
    const second = api.next('update');
    expect(second).toMatchObject({ changes: { status: 'done', priority: 'high' }, baseVersion: 2 });
    second.resolve({ ok: true, value: { ...task, status: 'done', priority: 'high', version: 3 } });
    await flush();
    expect(store.getState().pending[task.id]).toBeUndefined();
    expect(store.getState().tasks[task.id]).toMatchObject({ status: 'done', priority: 'high', version: 3 });
  });

  it('409 where the server changed a DIFFERENT field: rebases and retries automatically (#3)', async () => {
    const { api, store, task } = setup();
    store.getState().updateTask(task.id, { status: 'done' });
    const serverCopy = { ...task, priority: 'high' as const, version: 2 };
    api.next('update').resolve({ ok: false, kind: 'conflict', current: serverCopy, message: '' });
    await flush();
    const retry = api.next('update');
    expect(retry).toMatchObject({ changes: { status: 'done' }, baseVersion: 2 });
    retry.resolve({ ok: true, value: { ...serverCopy, status: 'done', version: 3 } });
    await flush();
    expect(store.getState().tasks[task.id]).toMatchObject({ status: 'done', priority: 'high', version: 3 });
    expect(store.getState().error).toBeNull();
  });

  it('no retry after a rebase when the task was deleted meanwhile', async () => {
    const { api, store, task } = setup();
    store.getState().updateTask(task.id, { status: 'done' });
    store.getState().deleteTask(task.id);
    api.next('update').resolve({ ok: false, kind: 'conflict', current: { ...task, priority: 'high', version: 2 }, message: '' });
    await flush();
    expect(api.calls.filter((c) => c.op === 'update')).toHaveLength(0);
    expect(store.getState().tasks[task.id]).toBeUndefined();
  });

  it('409 where the server changed the SAME field: the server wins, your change is undone, an error is shown (#3)', async () => {
    const { api, store, task } = setup();
    store.getState().updateTask(task.id, { status: 'done' });
    api.next('update').resolve({ ok: false, kind: 'conflict', current: { ...task, status: 'in_progress', version: 2 }, message: '' });
    await flush();
    expect(api.calls).toHaveLength(0); // no retry
    expect(store.getState().tasks[task.id]?.status).toBe('in_progress');
    expect(store.getState().error).toMatch(/conflict/i);
  });

  it('network failure: the edit is undone and an error is shown (#12)', async () => {
    const { api, store, task } = setup();
    store.getState().updateTask(task.id, { status: 'done' });
    api.next('update').resolve({ ok: false, kind: 'network', message: 'the server is unreachable' });
    await flush();
    expect(store.getState().tasks[task.id]?.status).toBe('todo');
    expect(store.getState().error).toMatch(/unreachable/);
  });
});

describe('creating and deleting', () => {
  const input = { title: 'New', assignee: null, status: 'todo', priority: 'low' } as const;

  it('create: shown and selected immediately; the id is chosen by the client', async () => {
    const { api, store } = setup([]);
    const id = store.getState().createTask(input);
    expect(store.getState()).toMatchObject({ selectedId: id, tasks: { [id]: { title: 'New', version: 0 } } });
    const call = api.next('create');
    expect(call.task.id).toBe(id);
    call.resolve({ ok: true, value: { ...call.task, version: 1, createdAt: 1, updatedAt: 1 } });
    await flush();
    expect(store.getState().tasks[id]?.version).toBe(1);
  });

  it('an edit made before the create is confirmed is sent once it is', async () => {
    const { api, store } = setup([]);
    const id = store.getState().createTask(input);
    store.getState().updateTask(id, { status: 'done' });
    expect(api.calls.filter((c) => c.op === 'update')).toHaveLength(0); // not on the server yet
    const create = api.next('create');
    create.resolve({ ok: true, value: { ...create.task, version: 1, createdAt: 1, updatedAt: 1 } });
    await flush();
    expect(api.next('update')).toMatchObject({ changes: { status: 'done' }, baseVersion: 1 });
  });

  it('deleting a task while its create is in flight deletes it on the server once created (no orphan)', async () => {
    const { api, store } = setup([]);
    const id = store.getState().createTask(input);
    store.getState().deleteTask(id);
    expect(store.getState().tasks[id]).toBeUndefined();
    const create = api.next('create');
    create.resolve({ ok: true, value: { ...create.task, version: 1, createdAt: 1, updatedAt: 1 } });
    await flush();
    expect(api.next('remove').id).toBe(id);
    expect(store.getState().tasks[id]).toBeUndefined();
  });

  it('deleting a task while an edit to it is in flight: the edit\'s late answer does not bring it back', async () => {
    const { api, store, task } = setup();
    store.getState().updateTask(task.id, { status: 'done' });
    store.getState().deleteTask(task.id);
    api.next('update').resolve({ ok: true, value: { ...task, status: 'done', version: 2 } });
    await flush();
    expect(store.getState().tasks[task.id]).toBeUndefined();
    expect(store.getState().confirmed[task.id]).toBeUndefined();
  });

  it('delete: removed at once and unselected; restored with an error if the server call fails (#12)', async () => {
    const { api, store, task } = setup();
    store.getState().select(task.id);
    store.getState().deleteTask(task.id);
    expect(store.getState()).toMatchObject({ selectedId: null });
    expect(store.getState().tasks[task.id]).toBeUndefined();
    api.next('remove').resolve({ ok: false, kind: 'network', message: 'offline' });
    await flush();
    expect(store.getState().tasks[task.id]).toEqual(task);
    expect(store.getState().error).toMatch(/delete/);
  });
});

describe('server events in the store', () => {
  it('a burst of events notifies subscribers once (one render) (#17)', () => {
    const { store, ev, task } = setup();
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.getState().receive(Array.from({ length: 50 }, (_, i) => ev.updated({ ...task, version: i + 2 }, ['status'])));
    expect(notifications).toBe(1);
  });

  it('the selected task deleted by someone else: selection stays so the editor can say it was deleted (#10)', () => {
    const { store, ev, task } = setup();
    store.getState().select(task.id);
    store.getState().receive([ev.deleted(task, 'client:other-tab')]);
    expect(store.getState().selectedId).toBe(task.id);
    expect(store.getState().tasks[task.id]).toBeUndefined();
    expect(store.getState().tombstones[task.id]).toBeDefined();
  });
});
