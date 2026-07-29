/**
 * In-memory fake of `CronvelloClient` that mirrors the server's observable semantics:
 * tasks are created DISABLED, `start`/`stop` flip status, `hasTargetToken` reflects whether a
 * token was ever set (the token value itself is never read back), and `listTasks` is scoped to a
 * job. Reconcile/define tests run against this instead of a network. Every mutating call is logged
 * so tests can assert the exact request sequence.
 */

import type { CronvelloClient } from "../../src/client/client.js";
import type {
  JobCreateBody,
  PublicJob,
  PublicTask,
  RunNowResult,
  TaskCreateBody,
  TaskUpdateBody,
} from "../../src/internal/wire.js";

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

function emptyJob(name: string, description: string | null): PublicJob {
  return {
    id: nextId("job"),
    name,
    description,
    status: "ACTIVE",
    urgency: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    taskCount: 0,
    activeTaskCount: 0,
    errorTaskCount: 0,
  };
}

function taskFromCreate(jobId: string, jobName: string, body: TaskCreateBody): PublicTask {
  return {
    id: nextId("task"),
    jobId,
    jobName,
    name: body.name,
    description: body.description ?? null,
    schedule: body.schedule,
    timeZone: body.timeZone ?? "Europe/Berlin",
    type: "scheduled",
    status: "DISABLED", // server creates tasks disabled
    targetUrl: body.targetUrl ?? null,
    hasTargetToken: body.targetToken !== undefined && body.targetToken !== null,
    method: body.method ?? "POST",
    customHeaderNames: Object.keys(body.headers ?? {}),
    requestBody: body.requestBody ?? null,
    requestTimeoutMs: body.requestTimeoutMs ?? null,
    successCriteria: body.successCriteria ?? null,
    urgency: body.urgency ?? null,
    maxRetries: body.maxRetries ?? null,
    executionMode: body.executionMode ?? null,
    callbackTimeoutMs: body.callbackTimeoutMs ?? null,
    allowConcurrentRuns: body.allowConcurrentRuns ?? null,
    nextRun: null,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    hasOpenDlq: false,
    statusReason: "",
  };
}

export interface FakeClient {
  client: CronvelloClient;
  /** Ordered log of mutating operations, e.g. "createTask:digest", "start:task_3", "delete:task_4". */
  ops: string[];
  /** Direct access to the in-memory tables for assertions. */
  jobsTable: PublicJob[];
  tasksTable: PublicTask[];
}

export interface SeedTask extends Partial<PublicTask> {
  name: string;
}

/** Build a fake client, optionally pre-seeded with one job container and its tasks. */
export function fakeClient(seed?: { jobName: string; tasks?: SeedTask[] }): FakeClient {
  const jobsTable: PublicJob[] = [];
  const tasksTable: PublicTask[] = [];
  const ops: string[] = [];

  let container: PublicJob | undefined;
  if (seed) {
    container = emptyJob(seed.jobName, null);
    jobsTable.push(container);
    for (const t of seed.tasks ?? []) {
      tasksTable.push({
        ...taskFromCreate(container.id, container.name, { name: t.name, schedule: t.schedule ?? "0 0 * * *", targetUrl: "https://app/x" }),
        status: "ACTIVE",
        ...t,
      });
    }
  }

  const findTask = (id: string) => tasksTable.find((t) => t.id === id);

  const jobs = {
    async list() {
      return [...jobsTable];
    },
    async get(jobId: string) {
      const j = jobsTable.find((x) => x.id === jobId);
      if (!j) throw new Error(`no job ${jobId}`);
      return j;
    },
    async create(body: JobCreateBody) {
      ops.push(`createJob:${body.name}`);
      const j = emptyJob(body.name, body.description ?? null);
      jobsTable.push(j);
      return j;
    },
    async listTasks(jobId: string) {
      return tasksTable.filter((t) => t.jobId === jobId);
    },
    async createTask(jobId: string, body: TaskCreateBody) {
      ops.push(`createTask:${body.name}`);
      const job = jobsTable.find((x) => x.id === jobId)!;
      const t = taskFromCreate(jobId, job.name, body);
      tasksTable.push(t);
      return t;
    },
  };

  const tasks = {
    async start(taskId: string) {
      ops.push(`start:${taskId}`);
      const t = findTask(taskId)!;
      t.status = "ACTIVE";
      return t;
    },
    async stop(taskId: string) {
      ops.push(`stop:${taskId}`);
      const t = findTask(taskId)!;
      t.status = "DISABLED";
      return t;
    },
    async update(taskId: string, patch: TaskUpdateBody) {
      ops.push(`update:${taskId}:${Object.keys(patch).join(",")}`);
      const t = findTask(taskId)!;
      Object.assign(t, patch);
      if (patch.targetToken !== undefined) t.hasTargetToken = patch.targetToken !== null;
      return t;
    },
    async delete(taskId: string) {
      ops.push(`delete:${taskId}`);
      const i = tasksTable.findIndex((t) => t.id === taskId);
      if (i >= 0) tasksTable.splice(i, 1);
      return null;
    },
    async runNow(taskId: string): Promise<RunNowResult> {
      ops.push(`runNow:${taskId}`);
      return { success: true, runId: nextId("run") };
    },
  };

  const client = { jobs, tasks } as unknown as CronvelloClient;
  return { client, ops, jobsTable, tasksTable };
}
