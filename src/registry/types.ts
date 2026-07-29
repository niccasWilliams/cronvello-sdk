/**
 * Public types for the code-first registry layer (`defineCronvello`).
 */

import type { FetchLike } from "../internal/http.js";
import type { ExecutionMode, PublicTask, SuccessCriteria, Urgency } from "../internal/wire.js";

/** Where a run originated. */
export type CronvelloRunSource = "dispatch" | "local";

/** Context passed to a job handler when Cronvello fires it. */
export interface CronvelloJobContext<Payload = Record<string, unknown>> {
  /** The stable registry key of the job being run. */
  key: string;
  /** The cron schedule Cronvello fired for (echoed back in the request body). */
  schedule: string;
  /** Static payload configured on the job, if any. */
  payload: Payload;
  /** The full parsed request body Cronvello sent. */
  body: Record<string, unknown>;
  /** Raw request headers (lower-cased keys). */
  headers: Record<string, string>;
  /** True when this is an async_callback run (handler may take longer than the HTTP timeout). */
  isAsync: boolean;
  /** "dispatch" when Cronvello fired it over HTTP, "local" when invoked via `cronvello.trigger()`. */
  source: CronvelloRunSource;
  /** A key-scoped structured logger (the app logger, or a no-op when none is configured). */
  logger: CronvelloLogger;
  /** Aborts if the runtime cancels the request. */
  signal: AbortSignal | undefined;
}

/** Lifecycle hooks fired around every job run — for logging, metrics, error reporting (Sentry, …). */
export interface CronvelloHooks {
  /** Before the handler runs. */
  onJobStart?(info: { key: string; source: CronvelloRunSource; isAsync: boolean }): void | Promise<void>;
  /** After the handler resolves successfully. */
  onJobSuccess?(info: { key: string; source: CronvelloRunSource; durationMs: number; result: unknown }): void | Promise<void>;
  /** After the handler throws. The run still reports failure to Cronvello; this is for observability. */
  onJobError?(info: { key: string; source: CronvelloRunSource; durationMs: number; error: Error }): void | Promise<void>;
}

export type CronvelloJobHandler<Payload = Record<string, unknown>> = (
  ctx: CronvelloJobContext<Payload>,
) => unknown | Promise<unknown>;

/** Shape of a single job in the keyed-object form. */
export interface CronvelloJobConfig<Payload = Record<string, unknown>> {
  /** Cron expression, e.g. "0 8 * * *". Validated by Cronvello on sync. */
  schedule: string;
  /** The function that runs when the job fires. */
  handler: CronvelloJobHandler<Payload>;
  /** Human description (stored on the Cronvello task). */
  description?: string;
  /** IANA timezone for this job's schedule. Defaults to the app-level `timeZone`. */
  timeZone?: string;
  urgency?: Urgency;
  /** Max automatic retries on failure (0–20). */
  maxRetries?: number;
  /**
   * "sync" (default): handler runs inline, result returned in the HTTP response.
   * "async_callback": respond immediately, run in the background, post the result back.
   * Use async only for work that exceeds the request timeout AND a long-running (non-serverless) host.
   */
  executionMode?: ExecutionMode;
  /** Async-mode budget before Cronvello marks the run timed out (ms). */
  callbackTimeoutMs?: number;
  /** Allow a new run to start while a previous one is still in flight (default false). */
  allowConcurrentRuns?: boolean;
  /** Optional success assertions beyond the default 2xx. */
  successCriteria?: SuccessCriteria;
  /** Static payload merged into the request body Cronvello stores and sends. */
  payload?: Payload;
  /** Set false to keep the code but stop syncing/scheduling this job. */
  enabled?: boolean;
}

/** Array form — each entry carries its own stable `key`. */
export interface CronvelloJobConfigWithKey extends CronvelloJobConfig {
  /** Stable identity. Renaming the display elsewhere never breaks the link. */
  key: string;
}

/** Jobs may be declared as a keyed object (key = identity) or an array of keyed entries. */
export type CronvelloJobsInput =
  | Record<string, CronvelloJobConfig>
  | CronvelloJobConfigWithKey[];

export interface CronvelloLogger {
  debug?(msg: string, meta?: Record<string, unknown>): void;
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
  error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface CronvelloAppConfig {
  /** Your jobs — keyed object or array form. */
  jobs: CronvelloJobsInput;
  /**
   * App identity. Becomes the name of the single Cronvello Job container that holds all
   * your tasks. Must be stable and unique within your account.
   */
  appName: string;
  /**
   * Public base URL of THIS app, where Cronvello delivers callbacks.
   * e.g. "https://app.example.com". The dispatch handler is mounted under it.
   */
  appUrl: string;
  /** Cronvello account API key (`crn_live_…`). */
  apiKey: string;
  /**
   * Shared secret. Cronvello sends it back as `Authorization: Bearer <secret>` on every
   * dispatch; the mounted handler verifies it in constant time. Generate a strong random
   * value and store it in your env (e.g. `openssl rand -hex 32`).
   */
  dispatchSecret: string;
  /** Path the dispatch handler is mounted at. Default "/cronvello/dispatch". */
  dispatchPath?: string;
  /** Cronvello API base URL. Default "https://api.cronvello.com". */
  baseUrl?: string;
  /** Default timezone for jobs that don't set their own. Default "Europe/Berlin". */
  timeZone?: string;
  /** Per-request API timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Retry attempts for transient API failures (default 2). */
  maxRetries?: number;
  /** Custom fetch implementation (default: global fetch). */
  fetch?: FetchLike;
  /** Optional structured logger. Surfaced to handlers as `ctx.logger`. */
  logger?: CronvelloLogger;
  /** Lifecycle hooks fired around every run (logging/metrics/error reporting). */
  hooks?: CronvelloHooks;
  /** Reject inbound dispatch bodies larger than this many bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /**
   * Validate each job's cron schedule and IANA timezone at define time (default true). Catches
   * typos with a clear error instead of a silent server-side failure. Set false to bypass (e.g.
   * for a syntax the client validator doesn't recognise yet).
   */
  validateSchedules?: boolean;
}

/** Per-job result of a reconcile. */
export interface ReconcileTaskChange {
  key: string;
  action: "created" | "updated" | "unchanged" | "deleted" | "skipped";
  taskId: string | null;
  /** Field names that changed (for "updated"). */
  changedFields?: string[];
  reason?: string;
}

export interface ReconcileResult {
  jobId: string;
  jobName: string;
  /** True if the Job container was created during this sync. */
  jobCreated: boolean;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  changes: ReconcileTaskChange[];
  /** Resulting tasks — populated when the reconcile ran server-side (PUT /v1/registry). */
  tasks?: PublicTask[];
}

export interface SyncOptions {
  /**
   * Delete tasks in the app's Job container that are no longer in the registry.
   * Default true — the container is fully SDK-managed. Set false to leave orphans.
   */
  prune?: boolean;
  /** Re-write the dispatch secret on every task even if unchanged (use after rotating). */
  rotateSecret?: boolean;
  /** Compute the diff and return it WITHOUT making any changes. */
  dryRun?: boolean;
}
