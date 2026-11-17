import { createStore, type StoreApi } from 'zustand/vanilla';
import type { NewTask, ServerEvent, Task, TaskChanges } from '../../shared/types';
import type { ApiResult, TaskApi } from '../api/http';
import {
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
  type CreateOutcome,
  type DeleteOutcome,
  type UpdateOutcome,
} from './reducer';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';

export interface BoardStore extends BoardState {
  clientId: string;
  selectedId: string | null;
  connection: ConnectionStatus;
  /** Last error shown in the banner; cleared by dismissError(). */
  error: string | null;

  receive(events: readonly ServerEvent[]): void;
  setConnection(status: ConnectionStatus): void;
  select(id: string | null): void;
  updateTask(id: string, changes: TaskChanges): void;
  /** Returns the new task's id (chosen here, so a retried create is safe). */
  createTask(input: Omit<NewTask, 'id'>): string;
  deleteTask(id: string): void;
  dismissError(): void;
}

export interface StoreDeps {
  api: TaskApi;
  clientId: string;
  now?: () => number;
  newId?: () => string;
}

// API results -> reducer outcomes, each in one place.
function toUpdateOutcome(result: ApiResult<Task>): UpdateOutcome {
  if (result.ok) return { kind: 'ok', task: result.value };
  if (result.kind === 'conflict') return { kind: 'conflict', current: result.current };
  if (result.kind === 'not_found') return { kind: 'not_found' };
  return { kind: 'failed', message: result.message };
}
const toCreateOutcome = (result: ApiResult<Task>): CreateOutcome =>
  result.ok ? { kind: 'ok', task: result.value } : { kind: 'failed', message: result.message };
const toDeleteOutcome = (result: ApiResult<void>): DeleteOutcome =>
  result.ok ? { kind: 'ok' } : { kind: 'failed', message: result.message };

/**
 * The Zustand store: board state (from the pure reducer) + UI state + actions that talk to the server.
 * A factory, so the app has one store and every test gets its own with a fake API.
 */
export function createBoardStore({ api, clientId, now = Date.now, newId = () => crypto.randomUUID() }: StoreDeps): StoreApi<BoardStore> {
  /** Tasks with an update request in flight. At most one per task, so you never conflict with yourself (#13). */
  const inFlight = new Set<string>();

  return createStore<BoardStore>()((set, get) => {
    const fail = (message: string) => set({ error: message });

    /** Sends your pending changes for a task, then again if more arrived while it was in flight. */
    async function flush(id: string): Promise<void> {
      if (inFlight.has(id)) return; // will be picked up when the current request finishes
      const { pending, confirmed } = get();
      const changes = pending[id];
      const base = confirmed[id];
      if (!changes || !base || base.version === 0) return; // nothing to send, deleted, or create not confirmed yet

      inFlight.add(id);
      try {
        let result = await api.update(id, changes, base.version);
        // 409 because someone changed OTHER fields: re-apply yours on top of their version, once (#3).
        if (!result.ok && result.kind === 'conflict' && canRebase(base, result.current, changes)) {
          const current = result.current;
          set((s) => resolveUpdate(s, id, changes, { kind: 'rebased', current }, now()));
          if (get().tombstones[id] !== undefined) return; // deleted meanwhile: don't retry
          result = await api.update(id, changes, current.version);
        }
        const outcome = toUpdateOutcome(result);
        set((s) => resolveUpdate(s, id, changes, outcome, now()));
        if (outcome.kind === 'conflict') fail('Your change conflicted with a newer change and was undone.');
        if (outcome.kind === 'failed') fail(`Could not save: ${outcome.message}`);
      } finally {
        inFlight.delete(id);
      }
      if (get().pending[id]) void flush(id); // you kept editing while the request was in flight
    }

    function sendDelete(removed: Task): void {
      void api.remove(removed.id).then((result) => {
        set((s) => resolveDelete(s, removed, toDeleteOutcome(result), now()));
        if (!result.ok) fail(`Could not delete the task: ${result.message}`);
      });
    }

    return {
      ...initialBoardState(),
      clientId,
      selectedId: null,
      connection: 'connecting',
      error: null,

      receive: (events) => set((s) => applyServerEvents(s, events, clientId, now())),
      setConnection: (connection) => set({ connection }),
      select: (selectedId) => set({ selectedId }),
      dismissError: () => set({ error: null }),

      updateTask(id, changes) {
        set((s) => applyLocalChanges(s, id, changes, now()));
        void flush(id);
      },

      createTask(input) {
        const task: NewTask = { ...input, id: newId() };
        set((s) => ({ ...applyLocalCreate(s, task, now()), selectedId: task.id }));
        void api.create(task).then((result) => {
          if (result.ok && get().tombstones[task.id] === Infinity) {
            sendDelete(result.value); // you deleted it while the create was in flight: delete it on the server too
            return;
          }
          set((s) => resolveCreate(s, task.id, toCreateOutcome(result), now()));
          if (!result.ok) fail(`Could not create the task: ${result.message}`);
          else void flush(task.id); // edits made before the create was confirmed
        });
        return task.id;
      },

      deleteTask(id) {
        const removed = get().confirmed[id];
        if (!removed) return;
        set((s) => ({ ...applyLocalDelete(s, id, now()), selectedId: s.selectedId === id ? null : s.selectedId }));
        // Not on the server yet: the create's callback sends the delete once the create succeeds.
        if (removed.version > 0) sendDelete(removed);
      },
    };
  });
}
