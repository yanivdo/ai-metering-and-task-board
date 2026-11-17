/**
 * Time is injected (never read directly via Date.now() in business code) so tests can
 * control it precisely, e.g. to land a request exactly on a period boundary.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * Fixed window aligned to the Unix epoch. The window is [start, start + periodMs):
 * the start is inclusive and the end is exclusive, so every millisecond belongs to exactly one period
 * (edge case #10).
 */
export function periodStart(nowMs: number, periodMs: number): number {
  return Math.floor(nowMs / periodMs) * periodMs;
}

export function periodEnd(startMs: number, periodMs: number): number {
  return startMs + periodMs;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Whole seconds until the period ends, never less than 1 (used for the Retry-After header). */
export function secondsUntil(endMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((endMs - nowMs) / 1000));
}
