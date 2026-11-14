export type AshErrorCode =
  | "CONFIG_INVALID"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BUDGET_EXCEEDED"
  | "BUDGET_INVARIANT"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "MARKET_UNAVAILABLE"
  | "MARKET_AUTH_REQUIRED"
  | "MARKET_CAPABILITY_MISSING"
  | "MARKET_REFUSED"
  | "MARKET_PROTOCOL_ERROR"
  | "MODEL_UNAVAILABLE"
  | "MODEL_RESPONSE_INVALID"
  | "VERIFICATION_FAILED"
  | "INTEGRITY_FAILED"
  | "STATE_INVALID"
  | "LOCK_TIMEOUT"
  | "RATE_LIMITED"
  | "UNSAFE_INPUT"
  | "UNSAFE_OPERATION"
  | "NOT_IMPLEMENTED";

export interface AshErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  details?: Record<string, unknown>;
  hint?: string;
}

/**
 * Every expected failure in Ash is an AshError. The CLI renders `message`
 * and `hint`; the cause is kept for logs only and is redacted before display.
 */
export class AshError extends Error {
  readonly code: AshErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  readonly hint?: string;

  constructor(code: AshErrorCode, message: string, options: AshErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AshError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
    this.hint = options.hint;
  }
}

export function isAshError(error: unknown): error is AshError {
  return error instanceof AshError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

export function asAshError(error: unknown, fallbackCode: AshErrorCode = "STATE_INVALID"): AshError {
  if (isAshError(error)) return error;
  return new AshError(fallbackCode, errorMessage(error), { cause: error });
}
