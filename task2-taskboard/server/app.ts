import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { existsSync } from 'node:fs';
import { registerEventStream, type EventStreamOptions } from './events';
import { registerTaskRoutes, sendError } from './routes';
import type { TaskStore } from './taskStore';

export interface ServerDeps {
  store: TaskStore;
  /** Folder with the built React app (vite build). Omitted in tests and in `npm run dev`. */
  staticDir?: string;
  logger?: FastifyServerOptions['logger'];
  stream?: EventStreamOptions;
}

export function buildServer({ store, staticDir, logger = false, stream }: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger,
    bodyLimit: 16 * 1024, // a task is tiny; reject anything much larger
    // Strict validation: no type coercion (a numeric title is rejected, not turned into "123"),
    // and unknown fields are rejected instead of silently removed.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  // One JSON error shape for every failure.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.validation ? 400 : (error.statusCode ?? 500);
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    const code = error.validation ? 'VALIDATION_ERROR' : status >= 500 ? 'INTERNAL_ERROR' : (error.code ?? 'BAD_REQUEST');
    return sendError(reply, status, code, status >= 500 ? 'Internal server error' : error.message);
  });

  app.get('/api/health', async () => ({ status: 'ok', tasks: store.size }));
  registerTaskRoutes(app, store);
  registerEventStream(app, store, stream);

  const serveApp = staticDir !== undefined && existsSync(staticDir);
  if (serveApp) app.register(fastifyStatic, { root: staticDir });

  // Single-page app: unknown non-API GETs get index.html; everything else gets a JSON 404.
  app.setNotFoundHandler((request, reply) => {
    if (serveApp && request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
    return sendError(reply, 404, 'NOT_FOUND', `Route ${request.method} ${request.url} not found`);
  });

  return app;
}
