/**
 * Error taxonomy for the SDK. Everything thrown by the public surface is a
 * `CronvelloError` (or subclass), so callers can `catch (e) { if (e instanceof CronvelloError) … }`.
 */

export class CronvelloError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronvelloError";
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A non-2xx response from the Cronvello API. */
export class CronvelloApiError extends CronvelloError {
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable error code from the API body, when present. */
  readonly code: string | undefined;
  /** The method + path that failed, e.g. `POST /v1/jobs`. */
  readonly endpoint: string;
  /** Parsed response body (best effort). */
  readonly body: unknown;
  /** Seconds to wait before retrying, parsed from `Retry-After` / rate-limit payload (429 only). */
  readonly retryAfterSeconds: number | undefined;

  constructor(args: {
    status: number;
    endpoint: string;
    message: string;
    code?: string;
    body?: unknown;
    retryAfterSeconds?: number;
  }) {
    super(`[${args.status}] ${args.endpoint}: ${args.message}`);
    this.name = "CronvelloApiError";
    this.status = args.status;
    this.code = args.code;
    this.endpoint = args.endpoint;
    this.body = args.body;
    this.retryAfterSeconds = args.retryAfterSeconds;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A network/transport failure (DNS, connection reset, timeout) before any HTTP status. */
export class CronvelloNetworkError extends CronvelloError {
  readonly endpoint: string;
  override readonly cause: unknown;
  constructor(endpoint: string, cause: unknown) {
    super(`Network error calling ${endpoint}: ${describe(cause)}`);
    this.name = "CronvelloNetworkError";
    this.endpoint = endpoint;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A misconfiguration caught before any network call (missing apiKey, bad URL, …). */
export class CronvelloConfigError extends CronvelloError {
  constructor(message: string) {
    super(message);
    this.name = "CronvelloConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
