export interface ServerConfig {
  host: string;
  port: number;
  simulator: boolean;
  simIntervalMs: number;
  simMinTasks: number;
  simMaxTasks: number;
  logLevel: (typeof LOG_LEVELS)[number];
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

/** Node timers hold a signed 32-bit number of ms; larger values silently become 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function int(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return def;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${key} must be an integer, got "${env[key]}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}, got ${value}`);
  return value;
}

/** Validated once at startup; invalid values stop the server with a clear message. */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const simRaw = (env.SIMULATOR ?? 'on').trim().toLowerCase();
  if (simRaw !== 'on' && simRaw !== 'off') throw new ConfigError(`SIMULATOR must be "on" or "off", got "${env.SIMULATOR}"`);
  const logLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${env.LOG_LEVEL}"`);
  }

  const config: ServerConfig = {
    host: env.HOST?.trim() || '127.0.0.1',
    port: int(env, 'PORT', 4000, 0, 65535),
    simulator: simRaw === 'on',
    simIntervalMs: int(env, 'SIM_INTERVAL_MS', 4000, 100, MAX_TIMER_MS),
    simMinTasks: int(env, 'SIM_MIN_TASKS', 4, 0, 1000),
    simMaxTasks: int(env, 'SIM_MAX_TASKS', 20, 1, 1000),
    logLevel: logLevel as ServerConfig['logLevel'],
  };
  // With min >= max the simulator would be told to grow and shrink at the same time.
  if (config.simMinTasks >= config.simMaxTasks) throw new ConfigError('SIM_MIN_TASKS must be less than SIM_MAX_TASKS');
  return config;
}
