/**
 * Low-level, fully-typed client for the Cronvello public `/v1` API.
 *
 * This is the thin REST layer: one method per endpoint, request/response types straight
 * from the server contract. The high-level registry (`defineCronvello`) is built on top of
 * it. Use this directly when you need ad-hoc control beyond the registry model.
 */

import { Transport, type FetchLike } from "../internal/http.js";
import { CronvelloConfigError } from "../internal/errors.js";
import type {
  AccountRunsQuery,
  AccountTasksQuery,
  JobCreateBody,
  JobUpdateBody,
  MeResponse,
  PublicJob,
  PublicRun,
  PublicTask,
  RunNowResult,
  RegistryReconcileRequest,
  RegistryReconcileResponse,
  RunsPage,
  RunsQuery,
  TaskCreateBody,
  TasksPage,
  TaskUpdateBody,
  UsageResponse,
} from "../internal/wire.js";

/** The production Cronvello API. Override `baseUrl` only for self-hosting or testing. */
export const CRONVELLO_DEFAULT_BASE_URL = "https://api.cronvello.com";

export interface CronvelloClientOptions {
  /** Account API key (`crn_live_…`). Required. */
  apiKey: string;
  /** API base URL. Defaults to https://api.cronvello.com. */
  baseUrl?: string;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Retry attempts for 429/5xx/network errors (default 2). */
  maxRetries?: number;
  /** Custom fetch implementation (default: global fetch). */
  fetch?: FetchLike;
  /** Telemetry hook for every request attempt. */
  onRequest?: (info: { method: string; path: string; status: number; attempt: number; durationMs: number }) => void;
}

export class CronvelloClient {
  private readonly transport: Transport;
  /** The resolved base URL in use. */
  readonly baseUrl: string;

  /** Job container operations. */
  readonly jobs: JobsResource;
  /** Scheduled task operations. */
  readonly tasks: TasksResource;
  /** Execution-history (run) operations. */
  readonly runs: RunsResource;
  /** Account identity + usage. */
  readonly account: AccountResource;

  constructor(options: CronvelloClientOptions) {
    if (!options || !options.apiKey) {
      throw new CronvelloConfigError("CronvelloClient requires an `apiKey` (crn_live_…).");
    }
    this.baseUrl = (options.baseUrl ?? CRONVELLO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = new Transport({
      baseUrl: this.baseUrl,
      apiKey: options.apiKey,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.onRequest ? { onRequest: options.onRequest } : {}),
      defaultHeaders: { "user-agent": "cronvello-sdk" },
    });
    this.jobs = new JobsResource(this.transport);
    this.tasks = new TasksResource(this.transport);
    this.runs = new RunsResource(this.transport);
    this.account = new AccountResource(this.transport);
  }

  /**
   * Atomically reconcile a whole code registry server-side (`PUT /v1/registry`): one job
   * container + its tasks, created/updated/pruned/started in a single call. This is what
   * `defineCronvello().sync()` prefers; the high-level API builds the body for you.
   */
  reconcileRegistry(body: RegistryReconcileRequest, opts?: { idempotencyKey?: string }): Promise<RegistryReconcileResponse> {
    return this.transport.request({
      method: "PUT",
      path: "/v1/registry",
      body,
      ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }

  /**
   * Escape hatch for endpoints not yet wrapped by a typed method (heartbeat monitors,
   * maintenance windows, DLQ, notification channels, audit log, API-key self-service …).
   * `T` is the response shape you expect.
   */
  request<T>(method: string, path: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; idempotencyKey?: string }): Promise<T> {
    return this.transport.request<T>({
      method,
      path,
      ...(opts?.query ? { query: opts.query } : {}),
      ...(opts?.body !== undefined ? { body: opts.body } : {}),
      ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
  }
}

class JobsResource {
  constructor(private readonly t: Transport) {}

  list(): Promise<PublicJob[]> {
    return this.t.request({ method: "GET", path: "/v1/jobs" });
  }
  get(jobId: string): Promise<PublicJob> {
    return this.t.request({ method: "GET", path: `/v1/jobs/${enc(jobId)}` });
  }
  create(body: JobCreateBody, opts?: { idempotencyKey?: string }): Promise<PublicJob> {
    return this.t.request({ method: "POST", path: "/v1/jobs", body, ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
  }
  update(jobId: string, body: JobUpdateBody): Promise<PublicJob> {
    return this.t.request({ method: "PATCH", path: `/v1/jobs/${enc(jobId)}`, body });
  }
  delete(jobId: string): Promise<null> {
    return this.t.request({ method: "DELETE", path: `/v1/jobs/${enc(jobId)}` });
  }
  start(jobId: string): Promise<PublicJob> {
    return this.t.request({ method: "POST", path: `/v1/jobs/${enc(jobId)}/start` });
  }
  stop(jobId: string): Promise<PublicJob> {
    return this.t.request({ method: "POST", path: `/v1/jobs/${enc(jobId)}/stop` });
  }
  listTasks(jobId: string): Promise<PublicTask[]> {
    return this.t.request({ method: "GET", path: `/v1/jobs/${enc(jobId)}/tasks` });
  }
  createTask(jobId: string, body: TaskCreateBody, opts?: { idempotencyKey?: string }): Promise<PublicTask> {
    return this.t.request({ method: "POST", path: `/v1/jobs/${enc(jobId)}/tasks`, body, ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
  }
}

class TasksResource {
  constructor(private readonly t: Transport) {}

  /** Account-wide paginated task table. */
  list(query?: AccountTasksQuery): Promise<TasksPage> {
    return this.t.request({ method: "GET", path: "/v1/tasks", ...(query ? { query: query as Record<string, string | number | boolean | undefined> } : {}) });
  }
  get(taskId: string): Promise<PublicTask> {
    return this.t.request({ method: "GET", path: `/v1/tasks/${enc(taskId)}` });
  }
  update(taskId: string, body: TaskUpdateBody): Promise<PublicTask> {
    return this.t.request({ method: "PATCH", path: `/v1/tasks/${enc(taskId)}`, body });
  }
  delete(taskId: string): Promise<null> {
    return this.t.request({ method: "DELETE", path: `/v1/tasks/${enc(taskId)}` });
  }
  start(taskId: string): Promise<PublicTask> {
    return this.t.request({ method: "POST", path: `/v1/tasks/${enc(taskId)}/start` });
  }
  stop(taskId: string): Promise<PublicTask> {
    return this.t.request({ method: "POST", path: `/v1/tasks/${enc(taskId)}/stop` });
  }
  /** Trigger a one-off manual execution (does not change the schedule). */
  runNow(taskId: string): Promise<RunNowResult> {
    return this.t.request({ method: "POST", path: `/v1/tasks/${enc(taskId)}/run` });
  }
  listRuns(taskId: string, query?: RunsQuery): Promise<RunsPage> {
    return this.t.request({ method: "GET", path: `/v1/tasks/${enc(taskId)}/runs`, ...(query ? { query: query as Record<string, string | number | boolean | undefined> } : {}) });
  }
}

class RunsResource {
  constructor(private readonly t: Transport) {}

  /** Account-wide paginated activity feed. */
  list(query?: AccountRunsQuery): Promise<RunsPage> {
    return this.t.request({ method: "GET", path: "/v1/runs", ...(query ? { query: query as Record<string, string | number | boolean | undefined> } : {}) });
  }
  get(runId: string): Promise<PublicRun> {
    return this.t.request({ method: "GET", path: `/v1/runs/${enc(runId)}` });
  }
}

class AccountResource {
  constructor(private readonly t: Transport) {}

  me(): Promise<MeResponse> {
    return this.t.request({ method: "GET", path: "/v1/me" });
  }
  usage(): Promise<UsageResponse> {
    return this.t.request({ method: "GET", path: "/v1/usage" });
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
