export interface RetryOptions {
  retries: number;
  /** Delay before the first retry, doubled each time. */
  baseDelayMs?: number;
  signal?: AbortSignal;
}

/** Errors worth retrying: rate limits, server errors and network failures. */
export class RetryableError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const base = options.baseDelayMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!(error instanceof RetryableError) || attempt >= options.retries || options.signal?.aborted) throw error;
      const delay = error.retryAfterMs ?? base * 2 ** attempt * (0.75 + Math.random() * 0.5);
      await sleep(delay, options.signal);
    }
  }
}

/** Combine a caller's signal with a timeout. */
export function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
