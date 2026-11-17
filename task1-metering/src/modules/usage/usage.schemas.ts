/**
 * JSON Schemas for request validation and response serialization.
 * Fastify compiles them once at startup: validation and JSON output are then precompiled
 * functions (cheap per request), and anything invalid is rejected with 400 before our code runs.
 * Type coercion is disabled in app.ts, so e.g. a numeric prompt is rejected instead of turned into a string.
 */

const userIdParams = {
  type: 'object',
  required: ['userId'],
  properties: {
    userId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  },
} as const;

const usageSnapshot = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    limit: { type: 'integer' },
    used: { type: 'integer' },
    inFlight: { type: 'integer' },
    remaining: { type: 'integer' },
    periodStart: { type: 'string' },
    periodEnd: { type: 'string' },
  },
} as const;

/** Fields every AI-request outcome has, success or failure. */
const outcomeFields = {
  requestId: { type: 'string' },
  status: { type: 'string' },
  charged: { type: 'boolean' },
  replayed: { type: 'boolean' },
  usage: usageSnapshot,
} as const;

const aiFailureResponse = {
  type: 'object',
  properties: {
    ...outcomeFields,
    error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
  },
} as const;

/**
 * At least one visible character: not whitespace and not an invisible zero-width character
 * (U+200B..U+200D zero-width space/joiners, U+2060 word joiner, U+FEFF BOM) (#16, #39).
 */
const HAS_VISIBLE_CHAR = '[^\\s\\u200B-\\u200D\\u2060\\uFEFF]';

export function aiRequestSchema(maxPromptChars: number) {
  return {
    response: {
      200: { type: 'object', properties: { ...outcomeFields, result: { type: 'string' } } },
      502: aiFailureResponse,
      503: aiFailureResponse,
      504: aiFailureResponse,
    },
    params: userIdParams,
    headers: {
      type: 'object',
      properties: {
        // Printable ASCII, no spaces: keys are opaque identifiers chosen by the client.
        'idempotency-key': { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7E]+$' },
      },
    },
    body: {
      type: 'object',
      required: ['prompt'],
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: maxPromptChars, pattern: HAS_VISIBLE_CHAR },
      },
    },
  } as const;
}

export const usageSchema = {
  params: userIdParams,
  response: { 200: usageSnapshot },
} as const;

export const eventsSchema = {
  params: userIdParams,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // 1..100 as a string (query values are strings and coercion is off).
      limit: { type: 'string', pattern: '^(100|[1-9][0-9]?)$' },
      cursor: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              errorCode: { type: ['string', 'null'] },
              idempotencyKey: { type: ['string', 'null'] },
              requestHash: { type: 'string' },
              promptChars: { type: 'integer' },
              quotaLimit: { type: 'integer' },
              periodStart: { type: 'string' },
              createdAt: { type: 'string' },
              finalizedAt: { type: ['string', 'null'] },
              latencyMs: { type: ['integer', 'null'] },
            },
          },
        },
        nextCursor: { type: ['string', 'null'] },
      },
    },
  },
} as const;

export const DEFAULT_EVENTS_PAGE_SIZE = 50;
