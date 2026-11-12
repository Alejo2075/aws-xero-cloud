export const ERROR_CODES = {
  INVALID_REQUEST: 400,
  INVALID_MANIFEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  FUNCTION_NOT_FOUND: 404,
  NOT_FOUND: 404,
  EVENT_SOURCE_NOT_FOUND: 404,
  FUNCTION_EXISTS: 409,
  TARGET_NOT_DEPLOYED: 409,
  INCOMPATIBLE_TARGET: 409,
  EVENT_SOURCE_INVALID: 400,
  ARTIFACT_INVALID: 400,
  ARTIFACT_TOO_LARGE: 413,
  PAYLOAD_TOO_LARGE: 413,
  PAYLOAD_INVALID: 400,
  RUNTIME_UNSUPPORTED: 400,
  CAPACITY_EXHAUSTED: 429,
  AWS_THROTTLED: 429,
  INVOCATION_TIMEOUT: 504,
  WORKER_START_FAILED: 502,
  WORKER_CRASHED: 502,
  WORKER_OOM: 502,
  BACKEND_UNAVAILABLE: 503,
  AWS_NOT_CONNECTED: 412,
  AWS_CREDENTIALS_ERROR: 502,
  AWS_ACCESS_DENIED: 403,
  AWS_TARGET_NOT_FOUND: 404,
  AWS_REQUEST_FAILED: 502,
  UNKNOWN_OUTCOME: 502,
  STATE_INCOMPATIBLE: 500,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Structured error with a stable machine-readable code. Never match on `message`. */
export class XeroError extends Error {
  override readonly name = 'XeroError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
  get httpStatus(): number {
    return ERROR_CODES[this.code];
  }
  toJSON(): { code: ErrorCode; message: string; details?: Readonly<Record<string, unknown>> } {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function isXeroError(e: unknown): e is XeroError {
  return e instanceof XeroError;
}

export function toXeroError(e: unknown): XeroError {
  if (isXeroError(e)) return e;
  return new XeroError('INTERNAL', 'internal error', undefined, { cause: e });
}
