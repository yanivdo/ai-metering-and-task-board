import type { FastifyInstance } from 'fastify';
import type { AiRequestOutcome, UsageService } from './usage.service.js';
import { aiRequestSchema, DEFAULT_EVENTS_PAGE_SIZE, eventsSchema, usageSchema } from './usage.schemas.js';

interface UserParams {
  userId: string;
}

/** How each non-success outcome maps to HTTP. The credit is never charged for these. */
const FAILURE_HTTP = {
  AI_ERROR: { status: 502, message: 'The AI provider failed; no credit was charged' },
  AI_TIMEOUT: { status: 504, message: 'The AI provider timed out; no credit was charged' },
  RESERVATION_EXPIRED: { status: 503, message: 'The request was interrupted before completing; no credit was charged' },
} as const;

/**
 * HTTP layer only: input arrives already validated (schemas), the service does the work,
 * and this file decides status codes and response shape. No SQL, no business rules.
 */
export function registerUsageRoutes(app: FastifyInstance, usage: UsageService, maxPromptChars: number): void {
  app.post<{ Params: UserParams; Body: { prompt: string }; Headers: { 'idempotency-key'?: string } }>(
    '/v1/users/:userId/ai-requests',
    { schema: aiRequestSchema(maxPromptChars) },
    async (request, reply) => {
      const outcome: AiRequestOutcome = await usage.submit({
        userId: request.params.userId,
        prompt: request.body.prompt,
        idempotencyKey: request.headers['idempotency-key'],
      });
      if (outcome.replayed) reply.header('idempotent-replayed', 'true');

      const charged = outcome.status === 'succeeded';
      const common = { requestId: outcome.requestId, status: outcome.status, charged, replayed: outcome.replayed, usage: outcome.usage };
      if (outcome.status === 'succeeded') {
        return reply.code(200).send({ ...common, result: outcome.result });
      }
      const failure = FAILURE_HTTP[outcome.errorCode];
      return reply.code(failure.status).send({ ...common, error: { code: outcome.errorCode, message: failure.message } });
    },
  );

  app.get<{ Params: UserParams }>('/v1/users/:userId/usage', { schema: usageSchema }, async (request) => {
    return usage.getUsage(request.params.userId);
  });

  app.get<{ Params: UserParams; Querystring: { limit?: string; cursor?: string } }>(
    '/v1/users/:userId/usage/events',
    { schema: eventsSchema },
    async (request) => {
      const limit = request.query.limit === undefined ? DEFAULT_EVENTS_PAGE_SIZE : Number(request.query.limit);
      return usage.listEvents(request.params.userId, limit, request.query.cursor);
    },
  );
}
