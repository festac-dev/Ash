import { AshError } from "../errors.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Bounded retries with exponential backoff and jitter. Never used for
 * non-idempotent market calls unless the caller supplies a replay-safe id.
 */
export async function withRetries<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1)
    throw new AshError("VALIDATION_FAILED", "Retry attempts must be a positive integer.");
  const attempts = options.attempts;
  const base = options.baseDelayMs ?? 400;
  const maxDelay = options.maxDelayMs ?? 8_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = options.retryable ? options.retryable(error) : true;
      if (!retryable || attempt === attempts) break;
      const delay = Math.min(maxDelay, base * 2 ** (attempt - 1));
      const jittered = Math.round(delay * (0.75 + Math.random() * 0.5));
      options.onRetry?.(error, attempt, jittered);
      await sleep(jittered);
    }
  }
  throw lastError;
}

/** Token-bucket limiter for outbound marketplace calls. */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;

  constructor(perMinute: number, now = Date.now()) {
    if (!Number.isFinite(perMinute) || perMinute <= 0)
      throw new AshError("VALIDATION_FAILED", "Rate limit must be finite and positive.");
    this.capacity = Math.max(1, perMinute);
    this.refillPerMs = this.capacity / 60_000;
    this.tokens = this.capacity;
    this.lastRefill = now;
  }

  async take(count = 1): Promise<void> {
    if (!Number.isFinite(count) || count <= 0 || count > this.capacity)
      throw new AshError("VALIDATION_FAILED", "Token count must fit within the rate limiter capacity.");
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.lastRefill) * this.refillPerMs);
      this.lastRefill = now;
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const waitMs = Math.ceil((count - this.tokens) / this.refillPerMs);
      await sleep(Math.min(waitMs, 1_000));
    }
  }
}
