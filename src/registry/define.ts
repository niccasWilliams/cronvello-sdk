/**
 * `defineCronvello` — the high-level, code-first entry point.
 *
 * Jobs alone are enough. This runs on your machine with no account and no network:
 *
 *   export const cronvello = defineCronvello({
 *     appName: "my-app",
 *     jobs: {
 *       "send-daily-digest": { schedule: "0 8 * * *", handler: async () => { … } },
 *       "cleanup-temp":      { schedule: "*\/15 * * * *", handler: async () => { … } },
 *     },
 *   });
 *
 *   npx cronvello dev                       // real scheduler, locally
 *   await cronvello.trigger("cleanup-temp") // run one handler now
 *
 * Add the hosted side later, when you want run history, alerts on missed runs and replay.
 * `apiKey`, `appUrl` and `dispatchSecret` are needed only from that point on, and only the
 * calls that use them complain if they're absent:
 *
 *   export const cronvello = defineCronvello({
 *     appName: "my-app",
 *     appUrl: process.env.APP_URL!,
 *     apiKey: process.env.CRONVELLO_API_KEY!,
 *     dispatchSecret: process.env.CRONVELLO_DISPATCH_SECRET!,
 *     jobs: { … },
 *   });
 *
 *   await cronvello.sync();                 // reconcile the registry to Cronvello (idempotent)
 *   app.post(cronvello.dispatchPath, express.json(), cronvello.expressHandler());
 */

import { CronvelloClient, CRONVELLO_DEFAULT_BASE_URL } from "../client/client.js";
import { CronvelloApiError, CronvelloConfigError } from "../internal/errors.js";
import { validateCron, isValidTimeZone } from "../internal/cron.js";
import type { RegistryReconcileRequest, RegistryTaskInput, RunNowResult } from "../internal/wire.js";
import { createDispatcher, type DispatchRequest, type DispatchResponse, type ResolvedJob } from "./dispatch.js";
import { reconcile } from "./reconcile.js";
import { expressHandler, type ExpressDispatchHandler } from "../adapters/express.js";
import { nextHandler, type NextRouteHandler } from "../adapters/next.js";
import { createLocalEngine, type EngineJob, type LocalEngine, type LocalEngineOptions } from "../dev/engine.js";
import type { DashboardOptions } from "../dev/dashboard.js";
import type {
  CronvelloAppConfig,
  CronvelloJobConfig,
  CronvelloJobsInput,
  ReconcileResult,
  SyncOptions,
} from "./types.js";

const DEFAULT_DISPATCH_PATH = "/cronvello/dispatch";
const DEFAULT_TIME_ZONE = "Europe/Berlin";

export interface CronvelloApp {
  /**
   * The underlying low-level client for ad-hoc `/v1` calls. Built on first access — reading it
   * on an app configured without an `apiKey` throws {@link CronvelloConfigError}.
   */
  readonly client: CronvelloClient;
  /** Resolved jobs, keyed by their stable registry key. */
  readonly jobs: ReadonlyMap<string, ResolvedJob>;
  /** The app identity / Job-container name. */
  readonly appName: string;
  /** Path the dispatch handler should be mounted at (e.g. "/cronvello/dispatch"). */
  readonly dispatchPath: string;
  /**
   * Absolute URL Cronvello calls back (appUrl + dispatchPath). Reading it on an app configured
   * without an `appUrl` throws {@link CronvelloConfigError} — a local-only app is never called back.
   */
  readonly dispatchUrl: string;
  /** True when this app has everything the hosted side needs (`apiKey`, `appUrl`, `dispatchSecret`). */
  readonly isCloudConfigured: boolean;

  /** Reconcile the registry into Cronvello. Idempotent — safe to call on every boot/deploy. */
  sync(options?: SyncOptions): Promise<ReconcileResult>;
  /** Trigger one job immediately via Cronvello (manual run). Requires a prior `sync()`. */
  run(key: string): Promise<RunNowResult>;
  /**
   * Run a job's handler locally, in-process — no HTTP round-trip, no Cronvello, no deploy.
   * Perfect for unit tests and `npx cronvello dev`. Lifecycle hooks fire (`source: "local"`).
   */
  trigger(key: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** Framework-neutral dispatch entry — used by the adapters. */
  handle(req: DispatchRequest): Promise<DispatchResponse>;
  /** Express/Connect request handler for the dispatch endpoint. */
  expressHandler(): ExpressDispatchHandler;
  /** Next.js App Router (Route Handler) for the dispatch endpoint. */
  nextHandler(): NextRouteHandler;
  /**
   * Start the **local engine** — run your jobs on this machine with no account, no cloud, no
   * network. Each job's next fire time is computed from its schedule (timezone/DST-aware) and its
   * handler runs locally, with overlap protection, per-run timeout, and retry/backoff enforced just
   * like the cloud. Returns the engine handle (history, snapshot, `stop()`); powers `cronvello dev`.
   *
   * Pass `autoStart: false` to construct the engine without starting it (the CLI does this to render
   * the job table first). Existing `sync()` / dispatch paths are untouched.
   */
  dev(options?: DevOptions): LocalEngine;
  /** The registry keys, for diagnostics. */
  keys(): string[];
}

/** Options for {@link CronvelloApp.dev}. */
export interface DevOptions extends LocalEngineOptions {
  /** Start the scheduler immediately (default true). Set false to start it yourself later. */
  autoStart?: boolean;
  /**
   * Also start the local web dashboard alongside the engine. `true` uses the defaults
   * (`http://127.0.0.1:4747`); pass an object to set `port`/`host`. `engine.stop()` closes it too.
   * The dashboard module is loaded lazily, so it never weighs down the main bundle.
   */
  dashboard?: boolean | DashboardOptions;
}

export function defineCronvello(config: CronvelloAppConfig): CronvelloApp {
  validateConfig(config);

  const validate = config.validateSchedules ?? true;
  const defaultTimeZone = config.timeZone ?? DEFAULT_TIME_ZONE;
  if (validate && !isValidTimeZone(defaultTimeZone)) {
    throw new CronvelloConfigError(`Invalid \`timeZone\` "${defaultTimeZone}" — expected an IANA name like "Europe/Berlin" or "UTC".`);
  }

  const jobs = normalizeJobs(config.jobs, validate);
  const dispatchPath = normalizePath(config.dispatchPath ?? DEFAULT_DISPATCH_PATH);

  // The cloud pieces are built on demand, so an app declared with jobs alone stays fully usable
  // locally (`dev()`, `trigger()`) and only complains when something actually needs the account.
  let clientInstance: CronvelloClient | undefined;
  const getClient = (): CronvelloClient => {
    if (!clientInstance) {
      requireCloud(config, ["apiKey"], "Talking to the Cronvello API");
      clientInstance = new CronvelloClient({
        apiKey: config.apiKey!,
        baseUrl: config.baseUrl ?? CRONVELLO_DEFAULT_BASE_URL,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
        ...(config.fetch ? { fetch: config.fetch } : {}),
      });
    }
    return clientInstance;
  };

  const dispatcher = createDispatcher({
    jobs,
    dispatchSecret: config.dispatchSecret,
    logger: config.logger,
    ...(config.hooks ? { hooks: config.hooks } : {}),
    ...(config.maxBodyBytes !== undefined ? { maxBodyBytes: config.maxBodyBytes } : {}),
  });

  const app: CronvelloApp = {
    get client(): CronvelloClient {
      return getClient();
    },
    jobs,
    appName: config.appName,
    dispatchPath,
    get dispatchUrl(): string {
      requireCloud(config, ["appUrl"], "Building the dispatch URL");
      return joinUrl(config.appUrl!, dispatchPath);
    },
    get isCloudConfigured(): boolean {
      return missingCloudFields(config, CLOUD_FIELDS).length === 0;
    },

    async sync(options?: SyncOptions): Promise<ReconcileResult> {
      requireCloud(config, CLOUD_FIELDS, "Syncing your jobs to Cronvello");
      const client = getClient();
      const dispatchUrl = joinUrl(config.appUrl!, dispatchPath);
      const dispatchSecret = config.dispatchSecret!;
      const opts = options ?? {};
      // Prefer the atomic server-side reconcile (one round-trip). dryRun is only supported by
      // the local differ, so it always takes the client-side path.
      if (!opts.dryRun) {
        try {
          const res = await client.reconcileRegistry(
            buildRegistryRequest(config, dispatchSecret, dispatchUrl, defaultTimeZone, [...jobs.values()], opts),
          );
          return {
            jobId: res.job.id,
            jobName: res.job.name,
            jobCreated: res.jobCreated,
            created: res.created,
            updated: res.updated,
            unchanged: res.unchanged,
            deleted: res.deleted,
            skipped: res.skipped,
            changes: res.changes.map((c) => ({
              key: c.key,
              action: c.action,
              taskId: c.taskId,
              ...(c.changedFields ? { changedFields: c.changedFields } : {}),
            })),
            tasks: res.tasks,
          };
        } catch (e) {
          // Older server without /v1/registry → fall back to the client-side differ.
          if (!(e instanceof CronvelloApiError) || (e.status !== 404 && e.status !== 405)) throw e;
        }
      }
      return reconcile(
        {
          client,
          appName: config.appName,
          dispatchUrl,
          dispatchSecret,
          defaultTimeZone,
          jobs: [...jobs.values()],
        },
        opts,
      );
    },

    async run(key: string): Promise<RunNowResult> {
      if (!jobs.has(key)) {
        throw new CronvelloConfigError(`Unknown job '${key}'. Known: ${[...jobs.keys()].join(", ") || "(none)"}`);
      }
      const client = getClient();
      const containers = await client.jobs.list();
      const container = containers.find((j) => j.name === config.appName);
      if (!container) {
        throw new CronvelloConfigError(`App '${config.appName}' is not synced yet — call sync() first.`);
      }
      const tasks = await client.jobs.listTasks(container.id);
      const task = tasks.find((t) => t.name === key);
      if (!task) {
        throw new CronvelloConfigError(`Job '${key}' has no task yet — call sync() first.`);
      }
      return client.tasks.runNow(task.id);
    },

    trigger: (key: string, payload?: Record<string, unknown>) => dispatcher.runLocal(key, payload),
    handle: dispatcher.handle,
    // Mounting a dispatch route that could only ever answer "not configured" hides the real
    // mistake behind a runtime 500, so both adapters fail at mount time instead.
    expressHandler: () => {
      requireCloud(config, ["dispatchSecret"], "Mounting the dispatch handler");
      return expressHandler(app);
    },
    nextHandler: () => {
      requireCloud(config, ["dispatchSecret"], "Mounting the dispatch handler");
      return nextHandler(app);
    },

    dev(options?: DevOptions): LocalEngine {
      const { autoStart = true, dashboard, ...engineOptions } = options ?? {};
      const engineJobs = buildEngineJobs([...jobs.values()], defaultTimeZone);
      const runner = (key: string, signal: AbortSignal) => dispatcher.runLocal(key, undefined, { signal });
      const engine = createLocalEngine(engineJobs, runner, engineOptions);
      if (autoStart) engine.start();
      if (dashboard) {
        const dashboardOptions = dashboard === true ? {} : dashboard;
        // Load lazily via the package's own `/dev` subpath. The non-literal specifier keeps the
        // bundler from inlining the dashboard (and its HTML) into the main `.` entry, so the cloud
        // client stays small; Node self-resolves it at runtime only when a dashboard is requested.
        const devSubpath = "@cronvello/sdk/dev";
        void (import(devSubpath) as Promise<typeof import("../dev/dashboard.js")>)
          .then(({ startDashboard }) => startDashboard(engine, dashboardOptions))
          .then((handle) => {
            engine.onStop(() => handle.close());
            console.log(`Cronvello dashboard → ${handle.url}`);
          })
          .catch((err: Error) => console.error(`Cronvello dashboard failed to start: ${err.message}`));
      }
      return engine;
    },

    keys: () => [...jobs.keys()],
  };

  return app;
}

/** Map resolved registry jobs to the local engine's job shape (skipping disabled jobs). */
function buildEngineJobs(jobs: ResolvedJob[], defaultTimeZone: string): EngineJob[] {
  const engineJobs: EngineJob[] = [];
  for (const { key, config } of jobs) {
    if (config.enabled === false) continue;
    const job: EngineJob = {
      key,
      schedule: config.schedule,
      timeZone: config.timeZone ?? defaultTimeZone,
      allowConcurrentRuns: config.allowConcurrentRuns ?? false,
      maxRetries: config.maxRetries ?? 0,
    };
    // `callbackTimeoutMs` is the cloud's per-run budget; reuse it as the local execution timeout.
    if (config.callbackTimeoutMs !== undefined) job.timeoutMs = config.callbackTimeoutMs;
    if (config.description !== undefined) job.description = config.description;
    engineJobs.push(job);
  }
  return engineJobs;
}

/** Config for `defineCronvello.fromEnv` — the three hosted-side fields are read from the environment. */
export type CronvelloEnvConfig = CronvelloAppConfig;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace defineCronvello {
  /**
   * Build an app from environment variables, so you don't repeat the same reads in every service.
   * Reads `CRONVELLO_API_KEY`, `CRONVELLO_DISPATCH_SECRET`, `CRONVELLO_APP_URL` (or `PUBLIC_URL`),
   * and optionally `CRONVELLO_API_URL` (base URL). Anything passed explicitly overrides the env.
   *
   *   export const cronvello = defineCronvello.fromEnv({ appName: "my-app", jobs: { … } });
   */
  export function fromEnv(
    config: CronvelloEnvConfig,
    env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
  ): CronvelloApp {
    const apiKey = config.apiKey ?? env["CRONVELLO_API_KEY"];
    const dispatchSecret = config.dispatchSecret ?? env["CRONVELLO_DISPATCH_SECRET"];
    const appUrl = config.appUrl ?? env["CRONVELLO_APP_URL"] ?? env["PUBLIC_URL"];
    const baseUrl = config.baseUrl ?? env["CRONVELLO_API_URL"];

    // fromEnv exists to wire up the hosted side, so it still fails fast on a half-configured
    // deploy rather than waiting for the first sync. Local-only apps skip it and call
    // defineCronvello() directly, which needs no credentials at all.
    const missing = [
      !apiKey && "CRONVELLO_API_KEY",
      !dispatchSecret && "CRONVELLO_DISPATCH_SECRET",
      !appUrl && "CRONVELLO_APP_URL (or PUBLIC_URL)",
    ].filter(Boolean);
    if (missing.length) {
      throw new CronvelloConfigError(
        `defineCronvello.fromEnv() is missing required env: ${missing.join(", ")}. ` +
          `To run locally with no account, use defineCronvello({ appName, jobs }) instead — it needs none of these.`,
      );
    }

    return defineCronvello({
      ...config,
      apiKey: apiKey!,
      dispatchSecret: dispatchSecret!,
      appUrl: appUrl!,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
}

/** The three fields the hosted side needs. Absent them, an app is local-only but fully usable. */
const CLOUD_FIELDS = ["apiKey", "appUrl", "dispatchSecret"] as const;
type CloudField = (typeof CLOUD_FIELDS)[number];

const CLOUD_FIELD_HINT: Record<CloudField, string> = {
  apiKey: "`apiKey` (crn_live_…, from your Cronvello account)",
  appUrl: "`appUrl` (the public https URL of THIS app, where Cronvello delivers callbacks)",
  dispatchSecret: "`dispatchSecret` (a random 32-byte value: run `npx cronvello secret`)",
};

function missingCloudFields(config: CronvelloAppConfig, fields: ReadonlyArray<CloudField>): CloudField[] {
  return fields.filter((f) => !config[f]);
}

/**
 * Guard the hosted-side entry points. Only these need an account — declaring jobs, running them
 * locally and `cronvello dev` never do, which is why the config no longer demands credentials
 * up front.
 */
function requireCloud(config: CronvelloAppConfig, fields: ReadonlyArray<CloudField>, purpose: string): void {
  const missing = missingCloudFields(config, fields);
  if (!missing.length) return;
  throw new CronvelloConfigError(
    `${purpose} needs config this app doesn't have: ${missing.map((f) => CLOUD_FIELD_HINT[f]).join(", ")}. ` +
      `Local runs (\`cronvello dev\`, \`trigger()\`) work without any of it.`,
  );
}

function validateConfig(config: CronvelloAppConfig): void {
  if (!config) throw new CronvelloConfigError("defineCronvello requires a config object.");
  if (!config.appName || !config.appName.trim()) throw new CronvelloConfigError("`appName` is required.");
  if (!config.jobs) throw new CronvelloConfigError("`jobs` is required.");
  // The cloud fields are optional, but a *present* value that is wrong is still a bug worth
  // catching here rather than at the first sync against production.
  if (config.appUrl !== undefined && !/^https?:\/\//i.test(config.appUrl)) {
    throw new CronvelloConfigError("`appUrl` must be an absolute http(s) URL (the public URL of THIS app).");
  }
  if (config.dispatchSecret !== undefined && config.dispatchSecret.length < 16) {
    throw new CronvelloConfigError("`dispatchSecret` must be at least 16 chars (use a random 32-byte value).");
  }
}

function normalizeJobs(input: CronvelloJobsInput, validate: boolean): Map<string, ResolvedJob> {
  const map = new Map<string, ResolvedJob>();
  const entries: Array<{ key: string; config: CronvelloJobConfig }> = Array.isArray(input)
    ? input.map(({ key, ...rest }) => ({ key, config: rest }))
    : Object.entries(input).map(([key, config]) => ({ key, config }));

  for (const { key, config } of entries) {
    const trimmed = (key ?? "").trim();
    if (!trimmed) throw new CronvelloConfigError("Every job needs a non-empty key.");
    if (trimmed.length > 255) throw new CronvelloConfigError(`Job key '${trimmed}' exceeds 255 characters.`);
    if (map.has(trimmed)) throw new CronvelloConfigError(`Duplicate job key '${trimmed}'.`);
    if (!config || typeof config.handler !== "function") {
      throw new CronvelloConfigError(`Job '${trimmed}' is missing a handler function.`);
    }
    if (!config.schedule || !config.schedule.trim()) {
      throw new CronvelloConfigError(`Job '${trimmed}' is missing a schedule.`);
    }
    if (validate) {
      const cronCheck = validateCron(config.schedule);
      if (!cronCheck.valid) {
        throw new CronvelloConfigError(`Job '${trimmed}' has an invalid schedule "${config.schedule}" — ${cronCheck.error}.`);
      }
      if (config.timeZone !== undefined && !isValidTimeZone(config.timeZone)) {
        throw new CronvelloConfigError(`Job '${trimmed}' has an invalid timeZone "${config.timeZone}" — expected an IANA name.`);
      }
    }
    map.set(trimmed, { key: trimmed, config });
  }
  if (map.size === 0) throw new CronvelloConfigError("At least one job is required.");
  return map;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") || "/" : `/${trimmed.replace(/\/+$/, "")}`;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

/** Build the PUT /v1/registry body from the registry jobs. */
function buildRegistryRequest(
  config: CronvelloAppConfig,
  dispatchSecret: string,
  dispatchUrl: string,
  defaultTimeZone: string,
  jobs: ResolvedJob[],
  opts: SyncOptions,
): RegistryReconcileRequest {
  const tasks: RegistryTaskInput[] = jobs.map((j) => {
    const cfg = j.config;
    const task: RegistryTaskInput = {
      key: j.key,
      schedule: cfg.schedule,
      targetUrl: dispatchUrl,
      targetToken: dispatchSecret,
      method: "POST",
      timeZone: cfg.timeZone ?? defaultTimeZone,
      requestBody: JSON.stringify({ job: j.key, ...(cfg.payload ?? {}) }),
    };
    if (cfg.description !== undefined) task.description = cfg.description;
    if (cfg.urgency !== undefined) task.urgency = cfg.urgency;
    if (cfg.maxRetries !== undefined) task.maxRetries = cfg.maxRetries;
    if (cfg.executionMode !== undefined) task.executionMode = cfg.executionMode;
    if (cfg.callbackTimeoutMs !== undefined) task.callbackTimeoutMs = cfg.callbackTimeoutMs;
    if (cfg.allowConcurrentRuns !== undefined) task.allowConcurrentRuns = cfg.allowConcurrentRuns;
    if (cfg.successCriteria !== undefined) task.successCriteria = cfg.successCriteria;
    if (cfg.enabled !== undefined) task.enabled = cfg.enabled;
    return task;
  });
  return {
    appName: config.appName,
    tasks,
    prune: opts.prune ?? true,
    rotateSecret: opts.rotateSecret ?? false,
  };
}
