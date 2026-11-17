/** Anything that can answer a prompt. The service depends on this interface, not on the mock. */
export interface AiClient {
  /** Must reject when `signal` aborts. */
  complete(prompt: string, signal: AbortSignal): Promise<string>;
}

export class AiProviderError extends Error {
  override name = 'AiProviderError';
}

export interface MockAiOptions {
  minDelayMs: number;
  maxDelayMs: number;
  failureRate: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/** Simulates an AI provider: random latency and occasional failures, and it honours cancellation. */
export class MockAiClient implements AiClient {
  private readonly random: () => number;

  constructor(private readonly opts: MockAiOptions) {
    this.random = opts.random ?? Math.random;
  }

  complete(_prompt: string, signal: AbortSignal): Promise<string> {
    const { minDelayMs, maxDelayMs, failureRate } = this.opts;
    const delay = minDelayMs + Math.floor(this.random() * (maxDelayMs - minDelayMs + 1));
    const fails = this.random() < failureRate;

    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        if (fails) reject(new AiProviderError('Simulated AI provider failure'));
        else resolve(`Simulated AI answer (took ${delay} ms)`);
      }, delay);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
