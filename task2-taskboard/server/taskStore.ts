import { randomUUID } from 'node:crypto';
import {
  EDITABLE_FIELDS,
  type ChangeSource,
  type EditableField,
  type NewTask,
  type ServerEvent,
  type Task,
  type TaskChanges,
} from '../shared/types';

/** An event before the store stamps it with seq + epoch. */
type EventBody = ServerEvent extends infer E ? (E extends ServerEvent ? Omit<E, 'seq' | 'epoch'> : never) : never;

export type CreateResult =
  | { kind: 'created'; task: Task }
  | { kind: 'exists'; task: Task } // same id + same content: a safe retry
  | { kind: 'conflict'; reason: string };

export type UpdateResult =
  | { kind: 'updated'; task: Task }
  | { kind: 'unchanged'; task: Task } // every change equals the current value: no new version, no event
  | { kind: 'conflict'; current: Task } // baseVersion is stale
  | { kind: 'not_found' };

export interface TaskStoreOptions {
  seed?: Task[];
  now?: () => number;
  /** How many recent events are kept for replay after a reconnect. */
  bufferSize?: number;
}

/**
 * The server's single source of truth: tasks in memory, a version per task, a global event
 * sequence, and a ring buffer of recent events for reconnecting clients.
 */
export class TaskStore {
  readonly epoch = randomUUID();
  private readonly tasks = new Map<string, Task>();
  /**
   * Recently deleted ids. A create with one of these ids is a conflict, never a resurrection.
   * Capped (oldest dropped first), so a long-running server's memory stays bounded.
   */
  private readonly deleted = new Set<string>();
  private static readonly DELETED_IDS_KEPT = 10_000;
  private readonly buffer: ServerEvent[] = [];
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly now: () => number;
  private readonly bufferSize: number;
  private seq = 0;

  constructor(opts: TaskStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.bufferSize = opts.bufferSize ?? 1000;
    for (const task of opts.seed ?? []) this.tasks.set(task.id, { ...task });
  }

  get size(): number {
    return this.tasks.size;
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  snapshot(): ServerEvent {
    return { type: 'snapshot', seq: this.seq, epoch: this.epoch, tasks: this.list() };
  }

  create(input: NewTask, source: ChangeSource): CreateResult {
    const existing = this.tasks.get(input.id);
    if (existing) {
      const same = EDITABLE_FIELDS.every((f) => existing[f] === input[f]);
      return same ? { kind: 'exists', task: existing } : { kind: 'conflict', reason: 'A task with this id already exists' };
    }
    if (this.deleted.has(input.id)) return { kind: 'conflict', reason: 'A task with this id was deleted' };

    const at = this.now();
    const task: Task = { ...input, version: 1, createdAt: at, updatedAt: at };
    this.tasks.set(task.id, task);
    this.emit({ type: 'task.created', task, source });
    return { kind: 'created', task };
  }

  /** baseVersion undefined = no conflict check (used by the simulator). */
  update(id: string, changes: TaskChanges, source: ChangeSource, baseVersion?: number): UpdateResult {
    const current = this.tasks.get(id);
    if (!current) return { kind: 'not_found' };
    if (baseVersion !== undefined && baseVersion !== current.version) return { kind: 'conflict', current };

    const changed = (Object.keys(changes) as EditableField[]).filter((f) => changes[f] !== current[f]);
    if (changed.length === 0) return { kind: 'unchanged', task: current };

    const task: Task = { ...current, ...changes, version: current.version + 1, updatedAt: this.now() };
    this.tasks.set(id, task);
    this.emit({ type: 'task.updated', task, changed, source });
    return { kind: 'updated', task };
  }

  /** Returns false if there was nothing to delete (already deleted or never existed). */
  delete(id: string, source: ChangeSource): boolean {
    const current = this.tasks.get(id);
    if (!current) return false;
    this.tasks.delete(id);
    this.deleted.add(id);
    if (this.deleted.size > TaskStore.DELETED_IDS_KEPT) {
      this.deleted.delete(this.deleted.values().next().value!); // a Set iterates in insertion order: oldest first
    }
    this.emit({ type: 'task.deleted', id, title: current.title, version: current.version + 1, source });
    return true;
  }

  /**
   * Events after `seq`, for a client resuming with Last-Event-ID. Returns null when the client is
   * too far behind (its events already left the buffer): it then needs a fresh snapshot.
   */
  eventsSince(seq: number): ServerEvent[] | null {
    if (seq > this.seq || seq < 0) return null; // from the future: not ours
    if (seq === this.seq) return [];
    const oldest = this.buffer[0];
    if (!oldest || oldest.seq > seq + 1) return null;
    return this.buffer.slice(seq + 1 - oldest.seq);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(body: EventBody): void {
    const event = { ...body, seq: ++this.seq, epoch: this.epoch } as ServerEvent;
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const listener of this.listeners) listener(event);
  }
}
