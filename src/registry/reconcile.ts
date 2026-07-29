/**
 * Idempotent reconciliation of a code registry into Cronvello.
 *
 * Model: ONE Job container per app (named `appName`), and one Task per registry job. The
 * Task's `name` IS the registry key — the stable identity used for matching, so renaming a
 * job's display/description never breaks the link. On each `sync()` we:
 *   1. ensure the Job container exists,
 *   2. diff registry tasks against the container's current tasks,
 *   3. create missing, patch changed, (optionally) delete removed,
 *   4. start newly-created tasks (Cronvello creates them DISABLED).
 *
 * The container is fully SDK-managed: only tasks inside THIS app's Job are ever touched.
 */

import type { CronvelloClient } from "../client/client.js";
import type {
  PublicJob,
  PublicTask,
  SuccessCriteria,
  TaskCreateBody,
  TaskUpdateBody,
} from "../internal/wire.js";
import type {
  ReconcileResult,
  ReconcileTaskChange,
  SyncOptions,
} from "./types.js";
import type { ResolvedJob } from "./dispatch.js";

export interface ReconcileInput {
  client: CronvelloClient;
  appName: string;
  appDescription?: string;
  dispatchUrl: string;
  dispatchSecret: string;
  defaultTimeZone: string;
  jobs: ResolvedJob[];
}

export async function reconcile(input: ReconcileInput, options: SyncOptions = {}): Promise<ReconcileResult> {
  const { client, appName, dispatchUrl, dispatchSecret, defaultTimeZone, jobs } = input;
  const prune = options.prune ?? true;
  const dryRun = options.dryRun ?? false;
  const rotateSecret = options.rotateSecret ?? false;

  // 1. Ensure the Job container.
  const { job: container, created: jobCreated } = await ensureContainer(client, appName, input.appDescription, dryRun);
  const jobId = container?.id ?? "(dry-run)";

  const changes: ReconcileTaskChange[] = [];
  const existingTasks = container && !jobCreated ? await client.jobs.listTasks(container.id) : [];
  const byKey = new Map(existingTasks.map((t) => [t.name, t] as const));
  const registryKeys = new Set(jobs.map((j) => j.key));

  // 2. Reconcile each registry job.
  for (const job of jobs) {
    const enabled = job.config.enabled ?? true;
    const existing = byKey.get(job.key);
    const desired = buildDesiredTask({ job, dispatchUrl, dispatchSecret, defaultTimeZone });

    if (!enabled) {
      // Keep the task but make sure it is not scheduled.
      if (existing && existing.status === "ACTIVE" && !dryRun) await client.tasks.stop(existing.id);
      changes.push({ key: job.key, action: "skipped", taskId: existing?.id ?? null, reason: "disabled in registry" });
      continue;
    }

    if (!existing) {
      if (dryRun || !container) {
        changes.push({ key: job.key, action: "created", taskId: null });
        continue;
      }
      const createBody: TaskCreateBody = { ...desired, targetToken: dispatchSecret };
      const task = await client.jobs.createTask(container.id, createBody, { idempotencyKey: `cv-create-${appName}-${job.key}` });
      await client.tasks.start(task.id); // tasks are created DISABLED
      changes.push({ key: job.key, action: "created", taskId: task.id });
      continue;
    }

    // Existing task — compute the diff.
    const { patch, changedFields } = diffTask(existing, desired, { rotateSecret, dispatchSecret });
    const needsStart = existing.status === "DISABLED";

    if (changedFields.length === 0 && !needsStart) {
      changes.push({ key: job.key, action: "unchanged", taskId: existing.id });
      continue;
    }
    if (!dryRun) {
      if (changedFields.length > 0) await client.tasks.update(existing.id, patch);
      if (needsStart) await client.tasks.start(existing.id);
    }
    changes.push({
      key: job.key,
      action: changedFields.length > 0 ? "updated" : "unchanged",
      taskId: existing.id,
      ...(changedFields.length > 0 ? { changedFields } : {}),
      ...(needsStart ? { reason: "re-activated" } : {}),
    });
  }

  // 3. Prune tasks no longer in the registry.
  if (prune) {
    for (const task of existingTasks) {
      if (registryKeys.has(task.name)) continue;
      if (!dryRun) await client.tasks.delete(task.id);
      changes.push({ key: task.name, action: "deleted", taskId: task.id });
    }
  }

  return summarize(jobId, appName, jobCreated, changes);
}

async function ensureContainer(
  client: CronvelloClient,
  appName: string,
  description: string | undefined,
  dryRun: boolean,
): Promise<{ job: PublicJob | null; created: boolean }> {
  const jobs = await client.jobs.list();
  const found = jobs.find((j) => j.name === appName);
  if (found) return { job: found, created: false };
  if (dryRun) return { job: null, created: true };
  const created = await client.jobs.create(
    { name: appName, ...(description ? { description } : {}) },
    { idempotencyKey: `cv-job-${appName}` },
  );
  return { job: created, created: true };
}

function buildDesiredTask(args: {
  job: ResolvedJob;
  dispatchUrl: string;
  dispatchSecret: string;
  defaultTimeZone: string;
}): TaskCreateBody {
  const { job, dispatchUrl, defaultTimeZone } = args;
  const cfg = job.config;
  const requestBody = JSON.stringify({ job: job.key, ...(cfg.payload ?? {}) });
  const body: TaskCreateBody = {
    name: job.key,
    schedule: cfg.schedule,
    timeZone: cfg.timeZone ?? defaultTimeZone,
    targetUrl: dispatchUrl,
    method: "POST",
    requestBody,
  };
  if (cfg.description !== undefined) body.description = cfg.description;
  if (cfg.urgency !== undefined) body.urgency = cfg.urgency;
  if (cfg.maxRetries !== undefined) body.maxRetries = cfg.maxRetries;
  if (cfg.executionMode !== undefined) body.executionMode = cfg.executionMode;
  if (cfg.callbackTimeoutMs !== undefined) body.callbackTimeoutMs = cfg.callbackTimeoutMs;
  if (cfg.allowConcurrentRuns !== undefined) body.allowConcurrentRuns = cfg.allowConcurrentRuns;
  if (cfg.successCriteria !== undefined) body.successCriteria = cfg.successCriteria;
  return body;
}

function diffTask(
  existing: PublicTask,
  desired: TaskCreateBody,
  opts: { rotateSecret: boolean; dispatchSecret: string },
): { patch: TaskUpdateBody; changedFields: string[] } {
  const patch: TaskUpdateBody = {};
  const changed: string[] = [];

  const set = <K extends keyof TaskUpdateBody>(field: K, value: TaskUpdateBody[K]) => {
    patch[field] = value;
    changed.push(field);
  };

  if (existing.schedule !== desired.schedule) set("schedule", desired.schedule);
  if (desired.timeZone !== undefined && existing.timeZone !== desired.timeZone) set("timeZone", desired.timeZone);
  if (existing.targetUrl !== desired.targetUrl) set("targetUrl", desired.targetUrl);
  if (existing.method !== (desired.method ?? "POST")) set("method", desired.method ?? "POST");
  if (!jsonEqual(existing.requestBody, desired.requestBody)) set("requestBody", desired.requestBody ?? null);

  // Optional fields: only reconcile when the registry explicitly sets them.
  if (desired.description !== undefined && (existing.description ?? undefined) !== desired.description) {
    set("description", desired.description);
  }
  if (desired.urgency !== undefined && existing.urgency !== desired.urgency) set("urgency", desired.urgency);
  if (desired.maxRetries !== undefined && existing.maxRetries !== desired.maxRetries) set("maxRetries", desired.maxRetries);
  if (desired.executionMode !== undefined && existing.executionMode !== desired.executionMode) {
    set("executionMode", desired.executionMode);
  }
  if (desired.callbackTimeoutMs !== undefined && existing.callbackTimeoutMs !== desired.callbackTimeoutMs) {
    set("callbackTimeoutMs", desired.callbackTimeoutMs);
  }
  if (desired.allowConcurrentRuns !== undefined && existing.allowConcurrentRuns !== desired.allowConcurrentRuns) {
    set("allowConcurrentRuns", desired.allowConcurrentRuns);
  }
  if (desired.successCriteria !== undefined && !deepEqual(existing.successCriteria, desired.successCriteria)) {
    set("successCriteria", desired.successCriteria as SuccessCriteria);
  }

  // The dispatch secret (targetToken) can't be read back — only (re)set it on demand or when absent.
  if (opts.rotateSecret || !existing.hasTargetToken) set("targetToken", opts.dispatchSecret);

  return { patch, changedFields: changed };
}

function jsonEqual(a: string | null, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == b;
  try {
    return deepEqual(JSON.parse(a), JSON.parse(b));
  } catch {
    return a === b;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a as object).sort();
  const bk = Object.keys(b as object).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[ak[i]!], (b as Record<string, unknown>)[bk[i]!])) return false;
  }
  return true;
}

function summarize(
  jobId: string,
  jobName: string,
  jobCreated: boolean,
  changes: ReconcileTaskChange[],
): ReconcileResult {
  const count = (a: ReconcileTaskChange["action"]) => changes.filter((c) => c.action === a).length;
  return {
    jobId,
    jobName,
    jobCreated,
    created: count("created"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    deleted: count("deleted"),
    skipped: count("skipped"),
    changes,
  };
}
