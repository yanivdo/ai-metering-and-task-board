import { hostname } from 'node:os';

/**
 * All runtime configuration, validated once at startup.
 * Invalid values fail fast with a clear message instead of misbehaving at runtime (edge case #15).
 */
export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** X: max charged requests per user per period. 0 = block everything. */
  quotaLimit: number;
  /** Length of the fixed window, in milliseconds. */
  quotaPeriodMs: number;
  maxPromptChars: number;
  aiMinDelayMs: number;
  aiMaxDelayMs: number;
  /** Probability (0..1) that the simulated AI call fails. */
  aiFailureRate: number;
  /** Hard timeout for the AI call. */
  aiTimeoutMs: number;
  /** A reservation older than this is considered abandoned (crashed instance) and expired by the sweeper. */
  reservationTtlMs: number;
  sweepIntervalMs: number;
  /** Hard deadline for graceful shutdown; after it the process force-exits with code 1 (#37). */
  shutdownTimeoutMs: number;
  instanceId: string;
  /**
   * Secret for HMAC-hashing prompts (edge case #28). With a plain SHA-256, identical prompts from
   * different users get identical hashes, and short prompts can be guessed by hashing common phrases.
   * Must be stable across restarts, or idempotent retries would no longer match their stored hash.
   */
  requestHashSecret: string;
  /** True when REQUEST_HASH_SECRET was not set and the local development default is used. */
  usingDefaultHashSecret: boolean;
  logLevel: LogLevel;
  /**
   * SQLite durability (edge case #34). FULL: a committed credit survives a power loss, but every commit
   * waits for the disk while blocking the event loop. NORMAL (with WAL): survives an app crash, may lose
   * the last commits on power loss, much lower latency.
   */
  dbSynchronous: 'FULL' | 'NORMAL';
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Node's timers hold a signed 32-bit number of milliseconds (~24.8 days). A larger value is silently
 * replaced by 1 ms, which would make every AI call time out instantly or the sweeper run every 1 ms (#42).
 */
const MAX_TIMER_MS = 2_147_483_647;
/** 10 years. Keeps period math (seconds * 1000, epoch ms) far inside safe-integer range (#42). */
const MAX_PERIOD_SECONDS = 315_360_000;

const DEFAULT_HASH_SECRET = 'local-dev-secret-change-me';

/** Reads a numeric variable: empty/missing -> default, otherwise parsed, type-checked and range-checked. */
function num(env: Env, key: string, def: number, min: number, max: number, integer: boolean): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return def;
  const value = Number(raw);
  const valid = integer ? /^-?\d+$/.test(raw) : Number.isFinite(value);
  if (!valid) throw new ConfigError(`${key} must be ${integer ? 'an integer' : 'a number'}, got "${env[key]}"`);
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}, got ${value}`);
  return value;
}

const int = (env: Env, key: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER) => num(env, key, def, min, max, true);
const float = (env: Env, key: string, def: number, min: number, max: number) => num(env, key, def, min, max, false);

/** Reads a variable that must be one of a fixed set of values (case-insensitive). */
function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], def: T, normalize: (s: string) => string): T {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return def;
  const value = normalize(raw);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')}, got "${env[key]}"`);
  }
  return value as T;
}

export function loadConfig(env: Env = process.env): Config {
  const config: Config = {
    host: env.HOST?.trim() || '127.0.0.1',
    port: int(env, 'PORT', 3000, 0, 65535),
    dbPath: env.DB_PATH?.trim() || './data/metering.db',
    quotaLimit: int(env, 'QUOTA_LIMIT', 10, 0),
    quotaPeriodMs: int(env, 'QUOTA_PERIOD_SECONDS', 3600, 1, MAX_PERIOD_SECONDS) * 1000,
    maxPromptChars: int(env, 'MAX_PROMPT_CHARS', 4000, 1, 100_000),
    aiMinDelayMs: int(env, 'AI_MIN_DELAY_MS', 100, 0, MAX_TIMER_MS),
    aiMaxDelayMs: int(env, 'AI_MAX_DELAY_MS', 1500, 0, MAX_TIMER_MS),
    aiFailureRate: float(env, 'AI_FAILURE_RATE', 0.1, 0, 1),
    aiTimeoutMs: int(env, 'AI_TIMEOUT_MS', 3000, 1, MAX_TIMER_MS),
    reservationTtlMs: int(env, 'RESERVATION_TTL_MS', 30_000, 1),
    sweepIntervalMs: int(env, 'SWEEP_INTERVAL_MS', 10_000, 100, MAX_TIMER_MS),
    shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 10_000, 100, MAX_TIMER_MS),
    instanceId: env.INSTANCE_ID?.trim() || `${hostname()}-${process.pid}`,
    requestHashSecret: env.REQUEST_HASH_SECRET ?? DEFAULT_HASH_SECRET,
    usingDefaultHashSecret: env.REQUEST_HASH_SECRET === undefined,
    logLevel: oneOf(env, 'LOG_LEVEL', LOG_LEVELS, 'info', (s) => s.toLowerCase()),
    dbSynchronous: oneOf(env, 'DB_SYNC', ['FULL', 'NORMAL'] as const, 'FULL', (s) => s.toUpperCase()),
  };

  if (config.requestHashSecret.length < 16) {
    throw new ConfigError('REQUEST_HASH_SECRET must be at least 16 characters');
  }

  // Cross-field rules.
  if (config.aiMinDelayMs > config.aiMaxDelayMs) {
    throw new ConfigError('AI_MIN_DELAY_MS must be <= AI_MAX_DELAY_MS');
  }
  // If the TTL were <= the AI timeout, the sweeper could expire a reservation whose AI call is still
  // legitimately running, making late successes (and limit overshoot) routine instead of exceptional.
  if (config.reservationTtlMs <= config.aiTimeoutMs) {
    throw new ConfigError('RESERVATION_TTL_MS must be greater than AI_TIMEOUT_MS');
  }
  return config;
}
