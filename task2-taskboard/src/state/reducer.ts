import type { EditableField, NewTask, ServerEvent, Task, TaskChanges } from '../../shared/types';
import { formatValue } from '../format';

/**
 * All shared-state transitions as pure functions: (state, input) -> new state.
 * No React and no network here, so every edge case is unit-testable.
 *
 * Each task exists in up to three forms:
 * - confirmed: the server's latest copy (version 0 = a create you sent that isn't confirmed yet)
 * - pending:   your changes the server hasn't confirmed yet
 * - tasks:     what the UI shows = confirmed + pending. Recomputed for a task whenever either changes.
 */

export type Actor = 'you' | 'another user' | 'server';

export interface ActivityEntry {
  id: number;
  at: number;
  actor: Actor;
  kind: 'created' | 'updated' | 'deleted' | 'conflict' | 'error';
  taskId: string;
  title: string;
  detail: string;
}

export interface BoardState {
  tasks: Record<string, Task>;
  confirmed: Record<string, Task>;
  pending: Record<string, TaskChanges>;
  /** Deleted id -> version of the delete. Infinity while your own delete is in flight. */
  tombstones: Record<string, number>;
  epoch: string | null;
  seq: number;
  /** Newest first, capped at ACTIVITY_LIMIT (#18). */
  activity: ActivityEntry[];
  nextActivityId: number;
}

export const ACTIVITY_LIMIT = 50;

/** The request didn't succeed (network, server error, invalid input). */
export type Failed = { kind: 'failed'; message: string };

/** How the server answered an update. 'rebased' only refreshes the server copy before a retry. */
export type UpdateOutcome =
  | { kind: 'ok'; task: Task }
  | { kind: 'rebased'; current: Task }
  | { kind: 'conflict'; current: Task }
  | { kind: 'not_found' }
  | Failed;
export type CreateOutcome = { kind: 'ok'; task: Task } | Failed;
export type DeleteOutcome = { kind: 'ok' } | Failed;

export function initialBoardState(): BoardState {
  return { tasks: {}, confirmed: {}, pending: {}, tombstones: {}, epoch: null, seq: 0, activity: [], nextActivityId: 1 };
}

// ---------------------------------------------------------------------------------------------
// Small helpers. They work on a "draft": a copy made once per transition, so a batch of 100
// events copies the maps once instead of 100 times (#17).
// ---------------------------------------------------------------------------------------------

function draftOf(s: BoardState): BoardState {
  return {
    ...s,
    tasks: { ...s.tasks },
    confirmed: { ...s.confirmed },
    pending: { ...s.pending },
    tombstones: { ...s.tombstones },
    activity: [...s.activity],
  };
}

/** Recomputes what the UI shows for one task: server copy + your unsent changes. */
function refresh(d: BoardState, id: string): void {
  const base = d.confirmed[id];
  if (!base) {
    delete d.tasks[id];
    delete d.pending[id];
    return;
  }
  const pending = d.pending[id];
  d.tasks[id] = pending ? { ...base, ...pending } : base;
}

function remove(d: BoardState, id: string): void {
  delete d.confirmed[id];
  refresh(d, id);
}

function log(d: BoardState, at: number, entry: Omit<ActivityEntry, 'id' | 'at'>): void {
  d.activity.unshift({ ...entry, id: d.nextActivityId++, at });
  if (d.activity.length > ACTIVITY_LIMIT) d.activity.length = ACTIVITY_LIMIT;
}

/** Removes the given fields from your pending changes, but only where they still hold the value you sent. */
function dropSent(d: BoardState, id: string, sent: TaskChanges): void {
  const pending = d.pending[id];
  if (!pending) return;
  const rest: TaskChanges = { ...pending };
  for (const f of Object.keys(sent) as EditableField[]) {
    if (rest[f] === sent[f]) delete rest[f];
  }
  if (Object.keys(rest).length === 0) delete d.pending[id];
  else d.pending[id] = rest;
}

function describe(before: Task | undefined, after: TaskChanges, fields: readonly EditableField[]): string {
  return fields
    .map((f) => (before ? `${f}: ${formatValue(f, before[f])} → ${formatValue(f, after[f])}` : `${f}: ${formatValue(f, after[f])}`))
    .join(', ');
}

function actorOf(source: string, clientId: string): Actor {
  if (source === `client:${clientId}`) return 'you';
  return source.startsWith('client:') ? 'another user' : 'server';
}

// ---------------------------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------------------------

/** Applies a batch of server events as ONE state change, so a burst renders once (#17). */
export function applyServerEvents(state: BoardState, events: readonly ServerEvent[], clientId: string, now: number): BoardState {
  if (events.length === 0) return state;
  const d = draftOf(state);
  for (const event of events) applyEvent(d, event, clientId, now);
  return d;
}

function applyEvent(d: BoardState, e: ServerEvent, clientId: string, now: number): void {
  if (e.type === 'snapshot') return applySnapshot(d, e);

  // Events from another server run arrive only after its snapshot; anything else is stale (#9).
  if (e.epoch !== d.epoch) return;
  // Duplicate or out-of-order delivery (#4).
  if (e.seq <= d.seq) return;
  d.seq = e.seq;

  if (e.type === 'task.deleted') {
    const known = d.confirmed[e.id];
    d.tombstones[e.id] = e.version; // also confirms your own in-flight delete (Infinity -> real version)
    remove(d, e.id);
    const actor = actorOf(e.source, clientId);
    if (known && actor !== 'you') log(d, now, { actor, kind: 'deleted', taskId: e.id, title: e.title, detail: '' });
    return;
  }

  const task = e.task;
  const tomb = d.tombstones[task.id];
  if (tomb !== undefined && task.version <= tomb) return; // a late update can't resurrect a deleted task (#6)
  const before = d.confirmed[task.id];
  if (before && before.version >= task.version) return; // stale, duplicate, or the echo of your own change (#4, #5)

  d.confirmed[task.id] = task;
  refresh(d, task.id);

  const actor = actorOf(e.source, clientId);
  if (actor === 'you') return; // already logged when you made the change
  if (e.type === 'task.created') {
    log(d, now, { actor, kind: 'created', taskId: task.id, title: task.title, detail: describe(undefined, task, ['assignee', 'status']) });
  } else {
    log(d, now, { actor, kind: 'updated', taskId: task.id, title: task.title, detail: describe(before, task, e.changed) });
  }
}

/** Replaces the server copy with the snapshot; keeps your unsent changes and in-flight creates/deletes (#8, #9). */
function applySnapshot(d: BoardState, e: Extract<ServerEvent, { type: 'snapshot' }>): void {
  const confirmed: Record<string, Task> = {};
  for (const task of e.tasks) {
    if (d.tombstones[task.id] !== Infinity) confirmed[task.id] = task; // your delete is still in flight
  }
  for (const task of Object.values(d.confirmed)) {
    if (task.version === 0 && !confirmed[task.id]) confirmed[task.id] = task; // your create is still in flight
  }
  const inFlightDeletes = Object.fromEntries(Object.entries(d.tombstones).filter(([, v]) => v === Infinity));
  const affected = new Set([...Object.keys(d.confirmed), ...Object.keys(confirmed)]);

  d.confirmed = confirmed;
  d.tombstones = e.epoch === d.epoch ? d.tombstones : inFlightDeletes; // a new server run starts with no history
  d.epoch = e.epoch;
  d.seq = e.seq;
  for (const id of affected) refresh(d, id);
}

// ---------------------------------------------------------------------------------------------
// Your own changes (optimistic: shown immediately, confirmed or undone when the server answers)
// ---------------------------------------------------------------------------------------------

export function applyLocalChanges(state: BoardState, id: string, changes: TaskChanges, now: number): BoardState {
  const shown = state.tasks[id];
  if (!shown) return state; // deleted meanwhile: nothing to change
  const fields = (Object.keys(changes) as EditableField[]).filter((f) => changes[f] !== shown[f]);
  if (fields.length === 0) return state;

  const d = draftOf(state);
  const confirmed = d.confirmed[id]!;
  const pending: TaskChanges = { ...d.pending[id], ...changes };
  // A field set back to the server's value is no longer a change.
  for (const f of Object.keys(pending) as EditableField[]) if (pending[f] === confirmed[f]) delete pending[f];
  if (Object.keys(pending).length === 0) delete d.pending[id];
  else d.pending[id] = pending;
  refresh(d, id);

  log(d, now, { actor: 'you', kind: 'updated', taskId: id, title: d.tasks[id]!.title, detail: describe(shown, changes, fields) });
  return d;
}

export function resolveUpdate(state: BoardState, id: string, sent: TaskChanges, outcome: UpdateOutcome, now: number): BoardState {
  const d = draftOf(state);
  // Deleted (by you or the server) while the request was in flight: a late answer must not
  // bring the task back (#6, #27).
  if (d.tombstones[id] !== undefined) {
    delete d.pending[id];
    refresh(d, id);
    return d;
  }
  const newer = (t: Task) => !d.confirmed[id] || d.confirmed[id]!.version < t.version;

  switch (outcome.kind) {
    case 'ok':
      if (newer(outcome.task)) d.confirmed[id] = outcome.task;
      dropSent(d, id, sent);
      break;
    case 'rebased':
      if (newer(outcome.current)) d.confirmed[id] = outcome.current;
      break;
    case 'conflict': {
      // Someone else changed the same field(s): the server wins and your change is undone (#3).
      if (newer(outcome.current)) d.confirmed[id] = outcome.current;
      dropSent(d, id, sent);
      const fields = Object.keys(sent) as EditableField[];
      log(d, now, {
        actor: 'you', kind: 'conflict', taskId: id, title: outcome.current.title,
        detail: `${fields.join(', ')} was changed by someone else; your change was undone`,
      });
      break;
    }
    case 'not_found': {
      const title = d.tasks[id]?.title ?? '';
      d.tombstones[id] = (d.confirmed[id]?.version ?? 0) + 1;
      remove(d, id);
      log(d, now, { actor: 'you', kind: 'error', taskId: id, title, detail: 'could not save: the task was deleted' });
      break;
    }
    case 'failed':
      dropSent(d, id, sent);
      log(d, now, { actor: 'you', kind: 'error', taskId: id, title: d.confirmed[id]?.title ?? '', detail: `could not save (${outcome.message}); change undone` });
      break;
  }
  refresh(d, id);
  return d;
}

export function applyLocalCreate(state: BoardState, input: NewTask, now: number): BoardState {
  const d = draftOf(state);
  d.confirmed[input.id] = { ...input, version: 0, createdAt: now, updatedAt: now };
  refresh(d, input.id);
  log(d, now, { actor: 'you', kind: 'created', taskId: input.id, title: input.title, detail: describe(undefined, input, ['assignee', 'status']) });
  return d;
}

export function resolveCreate(state: BoardState, id: string, outcome: CreateOutcome, now: number): BoardState {
  const d = draftOf(state);
  const current = d.confirmed[id];
  if (outcome.kind === 'ok') {
    if (current && current.version < outcome.task.version) d.confirmed[id] = outcome.task;
  } else if (current?.version === 0) {
    remove(d, id);
    log(d, now, { actor: 'you', kind: 'error', taskId: id, title: current.title, detail: `could not create (${outcome.message})` });
  }
  refresh(d, id);
  return d;
}

export function applyLocalDelete(state: BoardState, id: string, now: number): BoardState {
  const task = state.tasks[id];
  if (!task) return state;
  const d = draftOf(state);
  d.tombstones[id] = Infinity; // ignore every event for it until the server confirms
  remove(d, id);
  log(d, now, { actor: 'you', kind: 'deleted', taskId: id, title: task.title, detail: '' });
  return d;
}

/** `removed` is the server copy from before your delete, used to restore it if the delete fails. */
export function resolveDelete(state: BoardState, removed: Task, outcome: DeleteOutcome, now: number): BoardState {
  const d = draftOf(state);
  const id = removed.id;
  if (outcome.kind === 'ok') {
    if (d.tombstones[id] === Infinity) d.tombstones[id] = removed.version + 1;
  } else if (d.tombstones[id] === Infinity) {
    delete d.tombstones[id];
    d.confirmed[id] = removed;
    refresh(d, id);
    log(d, now, { actor: 'you', kind: 'error', taskId: id, title: removed.title, detail: `could not delete (${outcome.message}); restored` });
  }
  return d;
}

/**
 * After a 409: can your change be re-applied on top of the newer server copy?
 * Yes if the server didn't touch any field you changed (it changed something else) (#3).
 */
export function canRebase(base: Task, current: Task, changes: TaskChanges): boolean {
  return (Object.keys(changes) as EditableField[]).every((f) => base[f] === current[f]);
}
