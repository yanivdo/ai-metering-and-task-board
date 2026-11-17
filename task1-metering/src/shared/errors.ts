import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Domain errors carry their own HTTP status, so services stay HTTP-agnostic in logic
 * but routes don't need a big mapping table.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

export class QuotaExceededError extends AppError {
  /** retryAfterSeconds = null when waiting won't help (limit is 0), so no Retry-After header is sent (#27). */
  constructor(retryAfterSeconds: number | null, usage: unknown) {
    super(
      429,
      'QUOTA_EXCEEDED',
      retryAfterSeconds === null ? 'Quota is 0: requests are not allowed' : 'Quota exhausted for the current period',
      { usage },
      retryAfterSeconds === null ? {} : { 'retry-after': String(retryAfterSeconds) },
    );
  }
}

export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body');
  }
}

export class RequestInProgressError extends AppError {
  constructor(requestId: string) {
    super(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed', { requestId });
  }
}

export class StorageUnavailableError extends AppError {
  constructor() {
    super(503, 'STORAGE_UNAVAILABLE', 'Usage storage is unavailable; request rejected so no credit is used without evidence');
  }
}

/**
 * better-sqlite3 throws SqliteError with codes like SQLITE_BUSY, SQLITE_IOERR, SQLITE_CANTOPEN.
 * A closed connection is detected up front in app.ts (db.open), not by matching error text.
 */
function isStorageError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return err.name === 'SqliteError' || (typeof code === 'string' && code.startsWith('SQLITE_'));
}

/**
 * Single place that turns any thrown error into an HTTP response.
 * - AppError                → its own status/code
 * - Fastify schema errors   → 400 VALIDATION_ERROR
 * - Fastify 4xx (bad JSON, wrong content type, body too large) → passed through
 * - SQLite errors           → 503 (fail closed, edge case #22)
 * - anything else           → 500, details only in the log
 */
export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const fe = (error ?? {}) as Partial<FastifyError>;
  let appError: AppError;

  if (error instanceof AppError) {
    appError = error;
  } else if (fe.validation) {
    appError = new ValidationError(fe.message ?? 'Invalid request');
  } else if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
    appError = new AppError(fe.statusCode, fe.code ?? 'BAD_REQUEST', fe.message ?? 'Bad request');
  } else if (isStorageError(error)) {
    request.log.error({ err: error }, 'storage error');
    appError = new StorageUnavailableError();
  } else {
    request.log.error({ err: error }, 'unhandled error'); // details only in the log, never in the response
    appError = new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
  }

  reply.code(appError.statusCode).headers(appError.headers)
    .send({ error: { code: appError.code, message: appError.message }, ...appError.extra });
}
