import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CLIENT_ID_HEADER,
  PRIORITIES,
  STATUSES,
  TEAM,
  TITLE_MAX,
  VISIBLE_CHAR_PATTERN,
  type ChangeSource,
  type NewTask,
  type TaskChanges,
} from '../shared/types';
import type { TaskStore } from './taskStore';

const fields = {
  title: { type: 'string', minLength: 1, maxLength: TITLE_MAX, pattern: VISIBLE_CHAR_PATTERN },
  assignee: { anyOf: [{ type: 'string', enum: [...TEAM] }, { type: 'null' }] },
  status: { type: 'string', enum: [...STATUSES] },
  priority: { type: 'string', enum: [...PRIORITIES] },
} as const;

const clientHeaders = {
  type: 'object',
  properties: { [CLIENT_ID_HEADER]: { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$' } },
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

/** Who made the change, for the activity log ("you" / "another user"). */
function sourceOf(headers: Record<string, unknown>): ChangeSource {
  const id = headers[CLIENT_ID_HEADER];
  return typeof id === 'string' ? `client:${id}` : 'client:unknown';
}

/** The one JSON error shape used by every endpoint. */
export function sendError(reply: FastifyReply, status: number, code: string, message: string, extra: object = {}) {
  return reply.code(status).send({ error: { code, message }, ...extra });
}

/** REST API for changes made in the browser. Every change is broadcast to all browsers by the store. */
export function registerTaskRoutes(app: FastifyInstance, store: TaskStore): void {
  app.post<{ Body: NewTask }>(
    '/api/tasks',
    {
      schema: {
        headers: clientHeaders,
        body: {
          type: 'object',
          required: ['id', 'title', 'assignee', 'status', 'priority'],
          additionalProperties: false,
          properties: { id: { type: 'string', format: 'uuid' }, ...fields },
        },
      },
    },
    async (request, reply) => {
      const input: NewTask = { ...request.body, title: request.body.title.trim() };
      const result = store.create(input, sourceOf(request.headers));
      if (result.kind === 'conflict') return sendError(reply, 409, 'ID_CONFLICT', result.reason);
      return reply.code(result.kind === 'created' ? 201 : 200).send(result.task);
    },
  );

  app.patch<{ Params: { id: string }; Body: { changes: TaskChanges; baseVersion: number } }>(
    '/api/tasks/:id',
    {
      schema: {
        headers: clientHeaders,
        params: idParams,
        body: {
          type: 'object',
          required: ['changes', 'baseVersion'],
          additionalProperties: false,
          properties: {
            changes: { type: 'object', minProperties: 1, additionalProperties: false, properties: fields },
            baseVersion: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { changes, baseVersion } = request.body;
      const normalized = changes.title === undefined ? changes : { ...changes, title: changes.title.trim() };
      const result = store.update(request.params.id, normalized, sourceOf(request.headers), baseVersion);
      switch (result.kind) {
        case 'updated':
        case 'unchanged':
          return reply.send(result.task);
        case 'conflict':
          return sendError(reply, 409, 'VERSION_CONFLICT', 'The task was changed by someone else', { current: result.current });
        case 'not_found':
          return sendError(reply, 404, 'NOT_FOUND', 'Task not found (it may have been deleted)');
      }
    },
  );

  // Deleting is idempotent: deleting something already gone is still "it's gone" (204).
  app.delete<{ Params: { id: string } }>(
    '/api/tasks/:id',
    { schema: { headers: clientHeaders, params: idParams } },
    async (request, reply) => {
      store.delete(request.params.id, sourceOf(request.headers));
      return reply.code(204).send();
    },
  );
}
