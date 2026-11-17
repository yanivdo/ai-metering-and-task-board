import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { immediateTransaction, type Db } from '../../infrastructure/database.js';
import type { AiClient } from '../../infrastructure/mock-ai.js';
import {
  IdempotencyKeyReusedError,
  QuotaExceededError,
  RequestInProgressError,
  ValidationError,
} from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { toIso, type Clock } from '../../shared/time.js';
import type { QuotaService, UsageSnapshot } from '../quota/quota.service.js';
import type { EventErrorCode, PageCursor, UsageEvent, UsageRepository } from './usage.repository.js';

export interface AiRequestInput {
  userId: string;
  prompt: string;
  idempotencyKey?: string;
}

export type AiRequestOutcome =
  | { status: 'succeeded'; requestId: string; result: string; replayed: boolean; usage: UsageSnapshot }
  | { status: 'failed' | 'expired'; requestId: string; errorCode: EventErrorCode; replayed: boolean; usage: UsageSnapshot };

/** Public shape of a ledger row (no response body: it's only kept for idempotent replay). */
export interface PublicUsageEvent {
  id: string;
  status: UsageEvent['status'];
  errorCode: EventErrorCode | null;
  idempotencyKey: string | null;
  requestHash: string;
  promptChars: number;
  quotaLimit: number;
  periodStart: string;
  createdAt: string;
  finalizedAt: string | null;
  latencyMs: number | null;
}

export interface EventsPage {
  items: PublicUsageEvent[];
  nextCursor: string | null;
}

export interface UsageServiceOptions {
  aiTimeoutMs: number;
  instanceId: string;
  requestHashSecret: string;
}

export class AiTimeoutError extends Error {
  override name = 'AiTimeoutError';
}

/** The AI call never throws to the caller: the outcome is a value, so every path must handle both cases. */
type AiCallResult = { ok: true; result: string } | { ok: false; code: 'AI_ERROR' | 'AI_TIMEOUT' };

type ReserveResult =
  | { kind: 'existing'; event: UsageEvent }
  | { kind: 'quota_exceeded' }
  | { kind: 'reserved'; id: string; periodStart: number };

/** Counts Unicode code points, the same way the JSON-schema maxLength check does (#32). */
function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export class UsageService {
  private readonly reserveTx: (input: AiRequestInput, requestHash: string, now: number) => ReserveResult;
  private readonly finalizeTx: (id: string, userId: string, ps: number, ai: AiCallResult, now: number, latency: number) => void;

  constructor(
    db: Db,
    private readonly events: UsageRepository,
    private readonly quota: QuotaService,
    private readonly ai: AiClient,
    private readonly clock: Clock,
    private readonly opts: UsageServiceOptions,
    private readonly log: Logger,
  ) {
    // Step 2: idempotency lookup + quota reserve + ledger insert, atomically, holding the write lock
    // for microseconds only. Nothing slow (no AI call) ever happens inside a transaction.
    this.reserveTx = immediateTransaction(db, (input: AiRequestInput, requestHash: string, now: number): ReserveResult => {
      if (input.idempotencyKey !== undefined) {
        const existing = this.events.findByIdempotencyKey(input.userId, input.idempotencyKey);
        if (existing) return { kind: 'existing', event: existing };
      }
      const reservation = this.quota.reserve(input.userId, now);
      if (!reservation.ok) return { kind: 'quota_exceeded' };

      const id = randomUUID();
      this.events.insertReserved({
        id,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey ?? null,
        requestHash,
        promptChars: codePointLength(input.prompt),
        periodStart: reservation.periodStart,
        quotaLimit: reservation.limit,
        createdAt: now,
        instanceId: this.opts.instanceId,
      });
      return { kind: 'reserved', id, periodStart: reservation.periodStart };
    });

    // Step 4: finalize ledger row + counter in one transaction. Every update is guarded by the
    // expected current status, so a row the sweeper already expired is handled explicitly.
    this.finalizeTx = immediateTransaction(db, (id, userId, ps, ai, now, latency) => {
      if (ai.ok) {
        if (this.events.markSucceeded(id, now, latency, ai.result)) {
          this.quota.settle(userId, ps, 'charge');
        } else if (this.events.markSucceededLate(id, now, latency, ai.result)) {
          // The sweeper gave up on it, but the user received the answer, so it is charged (#9).
          this.quota.settle(userId, ps, 'charge_late');
          this.log.warn({ requestId: id, userId }, 'late success after reservation expired; charged');
        }
      } else if (this.events.markFailed(id, ai.code, now, latency)) {
        this.quota.settle(userId, ps, 'release');
      }
      // else: already expired by the sweeper, which already released the credit.
    });
  }

  async submit(input: AiRequestInput): Promise<AiRequestOutcome> {
    const requestHash = this.hashRequest(input.userId, input.prompt);
    const now = this.clock.now();

    const reserved = this.reserveTx(input, requestHash, now);
    if (reserved.kind === 'existing') return this.replay(reserved.event, requestHash);
    if (reserved.kind === 'quota_exceeded') {
      throw new QuotaExceededError(this.quota.retryAfterSeconds(now), this.quota.getUsage(input.userId, now));
    }

    // Step 3: the slow part, outside any lock.
    const started = performance.now();
    const ai = await this.callAi(input.prompt);
    const latency = Math.round(performance.now() - started);
    if (!ai.ok) this.log.warn({ requestId: reserved.id, userId: input.userId, errorCode: ai.code }, 'AI call failed; credit released');

    // If finalize throws (DB down), the reservation stays 'reserved' and the sweeper releases it
    // later; the error handler returns 503 and the user is not charged.
    try {
      this.finalizeTx(reserved.id, input.userId, reserved.periodStart, ai, this.clock.now(), latency);
    } catch (err) {
      this.log.error({ requestId: reserved.id, userId: input.userId, err }, 'finalize failed; sweeper will resolve the reservation');
      throw err;
    }

    // Usage of the CURRENT period (what the client can still do next). If the AI answered after a
    // period boundary, the credit was charged to the previous period, so this may show used: 0 (#40).
    const usage = this.quota.getUsage(input.userId);
    return ai.ok
      ? { status: 'succeeded', requestId: reserved.id, result: ai.result, replayed: false, usage }
      : { status: 'failed', requestId: reserved.id, errorCode: ai.code, replayed: false, usage };
  }

  getUsage(userId: string): UsageSnapshot {
    return this.quota.getUsage(userId);
  }

  listEvents(userId: string, limit: number, cursor?: string): EventsPage {
    const decoded = cursor === undefined ? undefined : decodeCursor(cursor);
    // Ask for one extra row: if it exists there is a next page (no COUNT query needed).
    const rows = this.events.listPage(userId, limit + 1, decoded);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toPublic),
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /**
   * HMAC instead of a plain hash (#28): identical prompts from different users get different hashes,
   * and nobody without the secret can test guesses against the stored hash. Still deterministic, so
   * an idempotent retry with the same prompt matches.
   */
  private hashRequest(userId: string, prompt: string): string {
    return createHmac('sha256', this.opts.requestHashSecret).update(userId).update('\0').update(prompt).digest('hex');
  }

  /** Same key seen before: never charge again (#3), reject a different body (#4) or an in-flight duplicate (#5, #30). */
  private replay(event: UsageEvent, requestHash: string): AiRequestOutcome {
    if (event.requestHash !== requestHash) throw new IdempotencyKeyReusedError();
    if (event.status === 'reserved') throw new RequestInProgressError(event.id);
    const usage = this.quota.getUsage(event.userId);
    if (event.status === 'succeeded') {
      return { status: 'succeeded', requestId: event.id, result: event.responseBody ?? '', replayed: true, usage };
    }
    return { status: event.status, requestId: event.id, errorCode: event.errorCode ?? 'AI_ERROR', replayed: true, usage };
  }

  /**
   * Hard timeout (#7). The abort signal asks the provider to stop, and the race guarantees we stop
   * waiting even if a provider ignores the signal. Never throws: failures become a typed result.
   */
  private async callAi(prompt: string): Promise<AiCallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new AiTimeoutError('AI call timed out')), this.opts.aiTimeoutMs);
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    try {
      return { ok: true, result: await Promise.race([this.ai.complete(prompt, controller.signal), timedOut]) };
    } catch (err) {
      return { ok: false, code: err instanceof AiTimeoutError ? 'AI_TIMEOUT' : 'AI_ERROR' };
    } finally {
      clearTimeout(timer);
    }
  }
}

function toPublic(e: UsageEvent): PublicUsageEvent {
  return {
    id: e.id,
    status: e.status,
    errorCode: e.errorCode,
    idempotencyKey: e.idempotencyKey,
    requestHash: e.requestHash,
    promptChars: e.promptChars,
    quotaLimit: e.quotaLimit,
    periodStart: toIso(e.periodStart),
    createdAt: toIso(e.createdAt),
    finalizedAt: e.finalizedAt === null ? null : toIso(e.finalizedAt),
    latencyMs: e.latencyMs,
  };
}

/** Opaque to clients: base64url of [createdAt, id]. */
function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id])).toString('base64url');
}

function decodeCursor(raw: string): PageCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) && parsed.length === 2
      && Number.isSafeInteger(parsed[0]) && typeof parsed[1] === 'string' && parsed[1].length > 0
    ) {
      return { createdAt: parsed[0] as number, id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new ValidationError('Invalid cursor');
}
