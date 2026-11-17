import { CLIENT_ID_HEADER, type NewTask, type Task, type TaskChanges } from '../../shared/types';

/**
 * Every outcome is a value, never a thrown error, so the caller must handle each case.
 * - conflict:  the task changed since your baseVersion (409); `current` is the server's copy
 * - not_found: the task was deleted (404)
 * - invalid:   the server rejected the input (400) or another 4xx
 * - network:   no answer (offline, timeout, server down) or a 5xx
 */
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'conflict'; current: Task; message: string }
  | { ok: false; kind: 'not_found'; message: string }
  | { ok: false; kind: 'invalid'; message: string }
  | { ok: false; kind: 'network'; message: string };

/** What the store needs from the server. Tests pass a fake implementation. */
export interface TaskApi {
  create(task: NewTask): Promise<ApiResult<Task>>;
  update(id: string, changes: TaskChanges, baseVersion: number): Promise<ApiResult<Task>>;
  remove(id: string): Promise<ApiResult<void>>;
}

const TIMEOUT_MS = 8000;

export function createHttpApi(clientId: string, baseUrl = ''): TaskApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { [CLIENT_ID_HEADER]: clientId, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
      return { ok: false, kind: 'network', message: timedOut ? 'the server did not answer in time' : 'the server is unreachable' };
    }

    if (res.status === 204) return { ok: true, value: undefined as T };
    const payload = (await res.json().catch(() => null)) as { error?: { message?: string }; current?: Task } | null;
    if (res.ok) return { ok: true, value: payload as T };

    const message = payload?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 409 && payload?.current) return { ok: false, kind: 'conflict', current: payload.current, message };
    if (res.status === 404) return { ok: false, kind: 'not_found', message };
    if (res.status >= 400 && res.status < 500) return { ok: false, kind: 'invalid', message };
    return { ok: false, kind: 'network', message };
  }

  return {
    create: (task) => call<Task>('POST', '/api/tasks', task),
    update: (id, changes, baseVersion) => call<Task>('PATCH', `/api/tasks/${encodeURIComponent(id)}`, { changes, baseVersion }),
    remove: (id) => call<void>('DELETE', `/api/tasks/${encodeURIComponent(id)}`),
  };
}
