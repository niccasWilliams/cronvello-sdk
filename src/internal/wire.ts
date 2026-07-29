/**
 * Wire types for the Cronvello public `/v1` API.
 *
 * These mirror the public API contract but are hand-authored as plain TypeScript so the SDK
 * ships with ZERO runtime dependencies. When the server contract changes, update these to
 * match. They are the single source of truth for the SDK's request/response shapes.
 */

export type Urgency = "low" | "medium" | "high" | "critical";
export type ExecutionMode = "sync" | "async_callback";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type JobStatus = "DISABLED" | "ACTIVE" | "ERROR" | "ERROR_MAX_RETRIES";
export type RunStatus = "queued" | "running" | "completed" | "failed";
export type RunType = "scheduled" | "manual";
export type CallbackStatus = "pending" | "acknowledged" | "completed" | "failed" | "timed_out";

/** Optional success assertions beyond the default 2xx check. */
export interface SuccessCriteria {
  statusCodeMin?: number;
  statusCodeMax?: number;
  bodyContains?: string;
  bodyJsonPath?: string;
  bodyJsonEquals?: string | number | boolean;
  bodyRegex?: string;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export interface PublicJob {
  id: string;
  name: string;
  description: string | null;
  status: JobStatus;
  urgency: Urgency | null;
  createdAt: string;
  updatedAt: string | null;
  taskCount: number;
  activeTaskCount: number;
  errorTaskCount: number;
}

export interface JobCreateBody {
  name: string;
  description?: string;
}

export interface JobUpdateBody {
  name?: string;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export interface TaskCreateBody {
  name: string;
  description?: string;
  /** Cron expression (validated server-side). */
  schedule: string;
  /** IANA timezone; defaults to "Europe/Berlin" server-side. */
  timeZone?: string;
  /** HTTPS endpoint Cronvello calls when the task is due. */
  targetUrl: string;
  /** Bearer token Cronvello attaches as `Authorization: Bearer <token>`. Encrypted at rest. */
  targetToken?: string;
  /** HTTP method for the outbound call (default POST). */
  method?: HttpMethod;
  /** Custom request headers (values encrypted at rest, never returned on read). */
  headers?: Record<string, string>;
  /** JSON string forwarded to the target as the request body. */
  requestBody?: string;
  requestTimeoutMs?: number;
  successCriteria?: SuccessCriteria;
  urgency?: Urgency;
  maxRetries?: number;
  executionMode?: ExecutionMode;
  callbackTimeoutMs?: number;
  allowConcurrentRuns?: boolean;
}

export interface TaskUpdateBody {
  name?: string;
  description?: string | null;
  schedule?: string;
  timeZone?: string;
  targetUrl?: string;
  targetToken?: string | null;
  method?: HttpMethod;
  headers?: Record<string, string> | null;
  requestBody?: string | null;
  requestTimeoutMs?: number | null;
  successCriteria?: SuccessCriteria | null;
  urgency?: Urgency;
  maxRetries?: number;
  executionMode?: ExecutionMode;
  callbackTimeoutMs?: number | null;
  allowConcurrentRuns?: boolean;
}

export interface PublicTask {
  id: string;
  jobId: string;
  jobName: string;
  name: string;
  description: string | null;
  schedule: string;
  timeZone: string;
  type: string;
  status: JobStatus;
  targetUrl: string | null;
  hasTargetToken: boolean;
  method: HttpMethod;
  customHeaderNames: string[];
  requestBody: string | null;
  requestTimeoutMs: number | null;
  successCriteria: SuccessCriteria | null;
  urgency: Urgency | null;
  maxRetries: number | null;
  executionMode: string | null;
  callbackTimeoutMs: number | null;
  allowConcurrentRuns: boolean | null;
  nextRun: string | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  createdAt: string;
  hasOpenDlq: boolean;
  statusReason: string;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
export interface PublicRun {
  id: string;
  jobTaskId: string;
  taskName: string;
  jobId: string;
  jobName: string;
  status: RunStatus;
  runType: RunType;
  httpStatusCode: number | null;
  responseBody: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  error: string | null;
  executionMode: string | null;
  callbackStatus: CallbackStatus | null;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface RunsPage {
  runs: PublicRun[];
  pagination: Pagination;
}

export interface TasksPage {
  tasks: PublicTask[];
  pagination: Pagination;
}

export interface RunNowResult {
  success: boolean;
  runId?: string;
  async?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Registry reconcile (server-side, PUT /v1/registry)
// ---------------------------------------------------------------------------
export interface RegistryTaskInput {
  key: string;
  schedule: string;
  targetUrl: string;
  targetToken?: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  requestBody?: string;
  requestTimeoutMs?: number;
  timeZone?: string;
  description?: string;
  urgency?: Urgency;
  maxRetries?: number;
  executionMode?: ExecutionMode;
  callbackTimeoutMs?: number;
  allowConcurrentRuns?: boolean;
  successCriteria?: SuccessCriteria;
  enabled?: boolean;
}

export interface RegistryReconcileRequest {
  appName: string;
  description?: string;
  tasks: RegistryTaskInput[];
  prune?: boolean;
  rotateSecret?: boolean;
}

export interface RegistryReconcileChange {
  key: string;
  action: "created" | "updated" | "unchanged" | "deleted" | "skipped";
  taskId: string | null;
  changedFields?: string[];
}

export interface RegistryReconcileResponse {
  job: PublicJob;
  jobCreated: boolean;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  changes: RegistryReconcileChange[];
  tasks: PublicTask[];
}

// ---------------------------------------------------------------------------
// Account / identity
// ---------------------------------------------------------------------------
export interface MeResponse {
  accountId: number;
  accountName: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  serverTime: string;
  plan: { planName: string; displayName: string } | null;
  limits: {
    maxJobs: number | null;
    maxTasksPerJob: number | null;
    minIntervalSeconds: number | null;
    rateLimitPerMinute: number | null;
    rateLimitPerHour: number | null;
  };
  usage: {
    jobsUsed: number;
    period: { start: string; end: string };
    executionCount: number;
    executionQuota: number | null;
  };
  summary: {
    openDlqCount: number;
    heartbeatNeedsAttention: number;
    activeMaintenanceWindows: number;
  };
}

export interface UsageResponse {
  accountId: number;
  serverTime: string;
  plan: { planName: string; displayName: string } | null;
  period: { start: string; end: string };
  usage: {
    executionCount: number;
    quota: number | null;
    quotaExceeded: boolean;
    quotaUsedPercent: number | null;
  };
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------
export interface RunsQuery {
  page?: number;
  limit?: number;
  status?: RunStatus;
  runType?: RunType;
}

export interface AccountTasksQuery {
  page?: number;
  limit?: number;
  jobId?: string;
  status?: JobStatus;
}

export interface AccountRunsQuery {
  page?: number;
  limit?: number;
  taskId?: string;
  jobId?: string;
  status?: RunStatus;
  runType?: RunType;
}
