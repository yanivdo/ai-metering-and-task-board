import type { ApiResult, TaskApi } from '../src/api/http';
import type { ChangeSource, EditableField, NewTask, ServerEvent, Task, TaskChanges } from '../shared/types';

/** Deterministic random numbers so randomized tests are repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let counter = 0;
export function makeTask(over: Partial<Task> = {}): Task {
  counter++;
  return {
    id: `t${counter}`,
    title: `Task ${counter}`,
    assignee: 'Alice',
    status: 'todo',
    priority: 'medium',
    version: 1,
    createdAt: counter,
    updatedAt: counter,
    ...over,
  };
}

export const EPOCH = 'epoch-1';

/** Builds server events with increasing seq numbers, like the real server. */
export class EventFactory {
  seq = 0;
  constructor(public epoch = EPOCH) {}

  snapshot(tasks: Task[]): ServerEvent {
    return { type: 'snapshot', seq: this.seq, epoch: this.epoch, tasks };
  }
  created(task: Task, source: ChangeSource = 'simulator'): ServerEvent {
    return { type: 'task.created', seq: ++this.seq, epoch: this.epoch, task, source };
  }
  updated(task: Task, changed: EditableField[], source: ChangeSource = 'simulator'): ServerEvent {
    return { type: 'task.updated', seq: ++this.seq, epoch: this.epoch, task, changed, source };
  }
  deleted(task: Task, source: ChangeSource = 'simulator'): ServerEvent {
    return { type: 'task.deleted', seq: ++this.seq, epoch: this.epoch, id: task.id, title: task.title, version: task.version + 1, source };
  }
}

type Call =
  | { op: 'create'; task: NewTask; resolve: (r: ApiResult<Task>) => void }
  | { op: 'update'; id: string; changes: TaskChanges; baseVersion: number; resolve: (r: ApiResult<Task>) => void }
  | { op: 'remove'; id: string; resolve: (r: ApiResult<void>) => void };

/** A fake API where every call waits until the test answers it, so network timing is fully controlled. */
export class FakeApi implements TaskApi {
  readonly calls: Call[] = [];

  create(task: NewTask) {
    return new Promise<ApiResult<Task>>((resolve) => this.calls.push({ op: 'create', task, resolve }));
  }
  update(id: string, changes: TaskChanges, baseVersion: number) {
    return new Promise<ApiResult<Task>>((resolve) => this.calls.push({ op: 'update', id, changes, baseVersion, resolve }));
  }
  remove(id: string) {
    return new Promise<ApiResult<void>>((resolve) => this.calls.push({ op: 'remove', id, resolve }));
  }

  /** Removes and returns the oldest unanswered call of the given kind. */
  next<K extends Call['op']>(op: K): Extract<Call, { op: K }> {
    const i = this.calls.findIndex((c) => c.op === op);
    if (i < 0) throw new Error(`no pending ${op} call`);
    return this.calls.splice(i, 1)[0] as Extract<Call, { op: K }>;
  }
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise((r) => setTimeout(r, 0));
