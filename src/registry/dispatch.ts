/**
 * Framework-neutral dispatch core.
 *
 * Cronvello fires a due task by POSTing to the app's dispatch URL with
 *   Authorization: Bearer <dispatchSecret>
 *   body: { job: "<registry-key>", schedule: "<cron>", ...payload, _callback?: {...} }
 *
 * This module verifies the bearer, selects the job by key, runs its handler, and returns a
 * response. The Express/Next adapters are thin shells that translate their request/response
 * objects to/from the neutral shapes below.
 */

import type { CronvelloHooks, CronvelloJobConfig, CronvelloJobContext, CronvelloLogger, CronvelloRunSource } from "./types.js";
import { parseBearer, signHmacSha256, timingSafeEqual } from "./verify.js";

export interface ResolvedJob {
  key: string;
  config: CronvelloJobConfig;
}

/** A logger that discards everything — used when the app configures none, so `ctx.logger` is always safe. */
export const NOOP_LOGGER: CronvelloLogger = {};

export interface DispatcherState {
  jobs: Map<string, ResolvedJob>;
  dispatchSecret: string;
  logger: CronvelloLogger | undefined;
  hooks?: CronvelloHooks | undefined;
  /** Reject inbound bodies larger than this many bytes (default 1 MiB). */
  maxBodyBytes?: number;
}

export interface DispatchRequest {
  method: string;
  /** Value of the Authorization header, if any. */
  authorization: string | undefined;
  /** Raw request body as text. */
  rawBody: string;
  /** Lower-cased request headers. */
  headers: Record<string, string>;
  /** Abort signal for the inbound request, if the host provides one. */
  signal?: AbortSignal;
  /**
   * Optional serverless lifecycle hook (e.g. Vercel/Cloudflare `ctx.waitUntil`). When present,
   * async_callback background work is registered with it so the function stays alive until done.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface DispatchResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Async-callback metadata Cronvello injects into the request body. */
interface CallbackEnvelope {
  url: string;
  runId: string;
  expectedSignatureHeader?: string;
  timeoutMs?: number;
}

export interface Dispatcher {
  handle(req: DispatchRequest): Promise<DispatchResponse>;
  /**
   * Run a job's handler in-process (no HTTP, no auth) — powers `cronvello.trigger()` and the local
   * engine. An optional `signal` is surfaced to the handler as `ctx.signal`, which the local engine
   * aborts when a run exceeds its timeout.
   */
  runLocal(key: string, payload?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

export function createDispatcher(state: DispatcherState): Dispatcher {
  const log = state.logger ?? NOOP_LOGGER;
  const hooks = state.hooks;
  const maxBodyBytes = state.maxBodyBytes ?? 1_048_576; // 1 MiB

  /** Run the handler with lifecycle hooks + timing. Hook failures never break the run. */
  async function invokeHandler(job: ResolvedJob, ctx: CronvelloJobContext): Promise<{ durationMs: number; result: unknown }> {
    await safeHook(() => hooks?.onJobStart?.({ key: job.key, source: ctx.source, isAsync: ctx.isAsync }), log);
    const startedAt = Date.now();
    try {
      const result = await job.config.handler(ctx);
      const durationMs = Date.now() - startedAt;
      log.debug?.(`[cronvello] job '${job.key}' completed in ${durationMs}ms`);
      await safeHook(() => hooks?.onJobSuccess?.({ key: job.key, source: ctx.source, durationMs, result }), log);
      return { durationMs, result };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const error = err instanceof Error ? err : new Error(String(err));
      log.error?.(`[cronvello] job '${job.key}' failed: ${error.message}`, { error: error.message });
      await safeHook(() => hooks?.onJobError?.({ key: job.key, source: ctx.source, durationMs, error }), log);
      throw error;
    }
  }

  function buildContext(key: string, job: ResolvedJob, req: DispatchRequest | null, body: Record<string, unknown>, isAsync: boolean, source: CronvelloRunSource, signal?: AbortSignal): CronvelloJobContext {
    return {
      key,
      schedule: typeof body["schedule"] === "string" ? (body["schedule"] as string) : (job.config.schedule ?? ""),
      payload: (job.config.payload as Record<string, unknown>) ?? {},
      body,
      headers: req?.headers ?? {},
      isAsync,
      source,
      logger: log,
      signal: req?.signal ?? signal,
    };
  }

  async function handle(req: DispatchRequest): Promise<DispatchResponse> {
    if (req.method.toUpperCase() !== "POST") {
      return resp(405, { ok: false, error: "Method not allowed" });
    }

    // 1. Authenticate: bearer must equal the dispatch secret (constant-time).
    const token = parseBearer(req.authorization);
    if (!token || !timingSafeEqual(token, state.dispatchSecret)) {
      log.warn?.("[cronvello] dispatch rejected: bad or missing bearer token");
      return resp(401, { ok: false, error: "Unauthorized" });
    }

    // 2. Guard body size before parsing (defence against oversized/abusive payloads).
    if (byteLength(req.rawBody) > maxBodyBytes) {
      log.warn?.(`[cronvello] dispatch rejected: body exceeds ${maxBodyBytes} bytes`);
      return resp(413, { ok: false, error: "Payload too large" });
    }

    // 3. Parse the body.
    let body: Record<string, unknown>;
    try {
      const parsed = req.rawBody ? JSON.parse(req.rawBody) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return resp(400, { ok: false, error: "Body must be a JSON object" });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return resp(400, { ok: false, error: "Invalid JSON body" });
    }

    // 4. Select the job by its registry key.
    const key = typeof body["job"] === "string" ? (body["job"] as string) : null;
    if (!key) {
      return resp(400, { ok: false, error: "Missing 'job' key in body" });
    }
    const job = state.jobs.get(key);
    if (!job) {
      log.warn?.(`[cronvello] dispatch for unknown job '${key}'`);
      return resp(404, { ok: false, error: `Unknown job: ${key}` });
    }

    const callback = readCallback(body["_callback"]);
    const isAsync = callback !== null;
    const ctx = buildContext(key, job, req, body, isAsync, "dispatch");

    // 5a. Async path — acknowledge now, run in the background, post the result back.
    if (callback) {
      const work = runAndReportCallback(job, ctx, callback, state.dispatchSecret, log, invokeHandler);
      if (req.waitUntil) req.waitUntil(work);
      else void work; // fire-and-forget on long-running hosts
      return resp(202, { ok: true, job: key, accepted: true });
    }

    // 5b. Sync path — run inline; the result IS the HTTP response Cronvello records.
    try {
      const { result } = await invokeHandler(job, ctx);
      return resp(200, { ok: true, job: key, result: result ?? null });
    } catch (err) {
      // Non-2xx → Cronvello records a failure and retries per the task's maxRetries.
      return resp(500, { ok: false, job: key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function runLocal(key: string, payload?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> {
    const job = state.jobs.get(key);
    if (!job) throw new Error(`Unknown job '${key}'. Known: ${[...state.jobs.keys()].join(", ") || "(none)"}`);
    const body: Record<string, unknown> = { job: key, schedule: job.config.schedule, ...(payload ?? {}) };
    const ctx = buildContext(key, job, null, body, false, "local", opts?.signal);
    const { result } = await invokeHandler(job, ctx);
    return result;
  }

  return { handle, runLocal };
}

async function runAndReportCallback(
  job: ResolvedJob,
  ctx: CronvelloJobContext,
  callback: CallbackEnvelope,
  secret: string,
  log: CronvelloLogger,
  invokeHandler: (job: ResolvedJob, ctx: CronvelloJobContext) => Promise<{ durationMs: number; result: unknown }>,
): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    const { durationMs, result } = await invokeHandler(job, ctx);
    payload = { runId: callback.runId, success: true, durationMs, result: result ?? null };
  } catch (err) {
    payload = {
      runId: callback.runId,
      success: false,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const bodyStr = JSON.stringify(payload);
    const header = callback.expectedSignatureHeader || "X-Webhook-Signature";
    const signature = await signHmacSha256(bodyStr, secret);
    const res = await fetch(callback.url, {
      method: "POST",
      headers: { "content-type": "application/json", [header]: signature },
      body: bodyStr,
    });
    if (!res.ok) {
      log.warn?.(`[cronvello] callback POST for job '${job.key}' returned ${res.status}`);
    }
  } catch (err) {
    log.error?.(`[cronvello] failed to deliver callback for job '${job.key}'`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Run a lifecycle hook, swallowing any error it throws so observability never breaks a job. */
async function safeHook(fn: () => void | Promise<void> | undefined, log: CronvelloLogger): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn?.(`[cronvello] a lifecycle hook threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Byte length of a UTF-8 string without allocating a Buffer when TextEncoder is available. */
function byteLength(s: string): number {
  if (!s) return 0;
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  return s.length;
}

function readCallback(value: unknown): CallbackEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["url"] !== "string" || typeof v["runId"] !== "string") return null;
  return {
    url: v["url"] as string,
    runId: v["runId"] as string,
    ...(typeof v["expectedSignatureHeader"] === "string"
      ? { expectedSignatureHeader: v["expectedSignatureHeader"] as string }
      : {}),
    ...(typeof v["timeoutMs"] === "number" ? { timeoutMs: v["timeoutMs"] as number } : {}),
  };
}

function resp(status: number, body: Record<string, unknown>): DispatchResponse {
  return { status, body };
}
