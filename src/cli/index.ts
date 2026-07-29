#!/usr/bin/env node
/**
 * The `cronvello` CLI — inspect and drive your Cronvello account from the terminal.
 *
 *   cronvello whoami                 account, plan, limits, usage
 *   cronvello list [jobName]         job containers, or the tasks inside one
 *   cronvello tasks [--job name]     account-wide task table
 *   cronvello runs [--limit n] [--status failed]   recent activity feed
 *   cronvello run <taskId>           trigger one task now
 *   cronvello run <jobName> <task>   …resolved by name
 *   cronvello status                 health overview (active tasks, open DLQ, recent failures)
 *   cronvello sync [configPath] [--dry]   reconcile a code registry (loads your module)
 *   cronvello dev  [configPath] [--dry-run]   start the local engine (run jobs locally, no account)
 *   cronvello preview "<cron>" [--tz <z>] [-n 5]   print the next N fire times of an expression
 *   cronvello trigger [configPath] <jobKey>   run a single job's handler once, locally
 *   cronvello secret                 generate a strong dispatch secret
 *
 * Auth comes from the environment: CRONVELLO_API_KEY (required), CRONVELLO_API_URL (optional base).
 * Global flags: --json (machine output), --no-color, -h/--help, -v/--version.
 */

import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { CronvelloClient } from "../client/client.js";
import { CronvelloApiError, CronvelloConfigError } from "../internal/errors.js";
import { formatSyncResult } from "../registry/format.js";
import { generateDispatchSecret } from "../index.js";
import type { CronvelloApp } from "../registry/define.js";
import type { EngineEvent, JobSnapshot } from "../dev/engine.js";
import { previewSchedule, upcomingFires, localTimeZone, type UpcomingFire } from "../internal/cron-schedule.js";
import type { PublicJob, PublicRun, PublicTask } from "../internal/wire.js";
import { box, brand, c, ICON, relativeTime, setColor, sym, table } from "./ui.js";

const require2 = createRequire(import.meta.url);
const VERSION: string = (() => {
  try {
    return (require2("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

interface Args {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Long flags that take a following value (e.g. `--limit 20`, `--tz Europe/Berlin`). */
const VALUE_FLAGS = ["limit", "status", "job", "type", "runType", "tz", "window", "count", "n", "port", "host"];
/** Short flags that take a following value (e.g. `-n 5`). */
const SHORT_VALUE_FLAGS = ["n", "c"];

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && VALUE_FLAGS.includes(key)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && SHORT_VALUE_FLAGS.includes(key)) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { command: positionals[0] ?? "", positionals: positionals.slice(1), flags };
}

const out = (s = ""): void => void process.stdout.write(s + "\n");
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

function makeClient(): CronvelloClient {
  const apiKey = process.env["CRONVELLO_API_KEY"];
  if (!apiKey) {
    throw new CronvelloConfigError("CRONVELLO_API_KEY is not set. Export your crn_live_… key first.");
  }
  const baseUrl = process.env["CRONVELLO_API_URL"];
  return new CronvelloClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

function statusColor(status: string): string {
  const s = status.toUpperCase();
  if (s === "ACTIVE" || s === "COMPLETED") return c.green(status);
  if (s === "DISABLED" || s === "QUEUED" || s === "RUNNING") return c.cyan(status);
  if (s.startsWith("ERROR") || s === "FAILED") return c.red(status);
  return c.yellow(status);
}

function header(subtitle: string): void {
  out(`${ICON} ${brand("Cronvello")} ${c.gray(subtitle)}`);
  out();
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdWhoami(useJson: boolean): Promise<void> {
  const me = await makeClient().account.me();
  if (useJson) return json(me);
  const u = me.usage;
  const quota = u.executionQuota == null ? "∞" : String(u.executionQuota);
  out(
    box(`${me.accountName}`, [
      `${c.dim("account")}   #${me.accountId}  ${me.isActive ? sym.ok : sym.fail} ${me.email}`,
      `${c.dim("plan")}      ${brand(me.plan?.displayName ?? "—")}`,
      `${c.dim("limits")}    ${me.limits.maxJobs ?? "∞"} jobs · ${me.limits.maxTasksPerJob ?? "∞"} tasks/job · ${me.limits.rateLimitPerMinute ?? "∞"}/min`,
      `${c.dim("usage")}     ${c.bold(String(u.executionCount))} / ${quota} executions  ${c.gray(`(${u.jobsUsed} jobs)`)}`,
      `${c.dim("attention")} ${me.summary.openDlqCount} DLQ · ${me.summary.heartbeatNeedsAttention} heartbeats · ${me.summary.activeMaintenanceWindows} maintenance`,
    ]),
  );
}

async function cmdList(jobName: string | undefined, useJson: boolean): Promise<void> {
  const client = makeClient();
  if (jobName) {
    const container = (await client.jobs.list()).find((j) => j.name === jobName);
    if (!container) throw new CronvelloConfigError(`No job container named "${jobName}".`);
    const tasks = await client.jobs.listTasks(container.id);
    if (useJson) return json(tasks);
    header(`tasks in "${container.name}"`);
    out(renderTasks(tasks));
    return;
  }
  const jobs = await client.jobs.list();
  if (useJson) return json(jobs);
  header("job containers");
  out(
    table(
      [{ header: "NAME" }, { header: "STATUS" }, { header: "TASKS", align: "right" }, { header: "ACTIVE", align: "right" }, { header: "ERRORS", align: "right" }, { header: "ID" }],
      jobs.map((j: PublicJob) => [
        c.bold(j.name),
        statusColor(j.status),
        String(j.taskCount),
        String(j.activeTaskCount),
        j.errorTaskCount ? c.red(String(j.errorTaskCount)) : c.gray("0"),
        c.gray(j.id),
      ]),
    ),
  );
  out();
  out(c.gray(`${jobs.length} container(s) · ${jobs.reduce((n, j) => n + j.taskCount, 0)} task(s)`));
}

function renderTasks(tasks: PublicTask[]): string {
  const now = Date.now();
  return table(
    [{ header: "TASK" }, { header: "STATUS" }, { header: "SCHEDULE" }, { header: "NEXT RUN" }, { header: "LAST" }],
    tasks.map((t) => [
      c.bold(t.name),
      statusColor(t.status),
      c.cyan(t.schedule),
      relativeTime(t.nextRun, now),
      t.lastRunStatus ? statusColor(t.lastRunStatus) : c.gray("—"),
    ]),
  );
}

async function cmdTasks(flags: Args["flags"], useJson: boolean): Promise<void> {
  const client = makeClient();
  const jobName = typeof flags["job"] === "string" ? flags["job"] : undefined;
  let jobId: string | undefined;
  if (jobName) {
    const container = (await client.jobs.list()).find((j) => j.name === jobName);
    if (!container) throw new CronvelloConfigError(`No job container named "${jobName}".`);
    jobId = container.id;
  }
  const page = await client.tasks.list({ limit: 100, ...(jobId ? { jobId } : {}) });
  if (useJson) return json(page);
  header(jobName ? `tasks · ${jobName}` : "all tasks");
  out(renderTasks(page.tasks));
}

async function cmdRuns(flags: Args["flags"], useJson: boolean): Promise<void> {
  const client = makeClient();
  const limit = clampLimit(flags["limit"]);
  const status = typeof flags["status"] === "string" ? (flags["status"] as PublicRun["status"]) : undefined;
  const page = await client.runs.list({ limit, ...(status ? { status } : {}) });
  if (useJson) return json(page);
  header(`recent runs${status ? ` · ${status}` : ""}`);
  const now = Date.now();
  out(
    table(
      [{ header: "WHEN" }, { header: "TASK" }, { header: "JOB" }, { header: "STATUS" }, { header: "HTTP", align: "right" }, { header: "TOOK", align: "right" }],
      page.runs.map((r: PublicRun) => [
        relativeTime(r.startedAt, now),
        c.bold(r.taskName),
        c.gray(r.jobName),
        statusColor(r.status),
        r.httpStatusCode == null ? c.gray("—") : String(r.httpStatusCode),
        r.durationMs == null ? c.gray("—") : `${r.durationMs}ms`,
      ]),
    ),
  );
  out();
  out(c.gray(`showing ${page.runs.length} of ${page.pagination.total} runs`));
}

async function cmdRun(positionals: string[], useJson: boolean): Promise<void> {
  const client = makeClient();
  let taskId: string;
  if (positionals.length >= 2) {
    const [jobName, taskName] = positionals;
    const container = (await client.jobs.list()).find((j) => j.name === jobName);
    if (!container) throw new CronvelloConfigError(`No job container named "${jobName}".`);
    const task = (await client.jobs.listTasks(container.id)).find((t) => t.name === taskName);
    if (!task) throw new CronvelloConfigError(`No task "${taskName}" in "${jobName}".`);
    taskId = task.id;
  } else if (positionals.length === 1) {
    taskId = positionals[0]!;
  } else {
    throw new CronvelloConfigError("Usage: cronvello run <taskId>  |  cronvello run <jobName> <taskName>");
  }
  const res = await client.tasks.runNow(taskId);
  if (useJson) return json(res);
  if (res.success) out(`${sym.ok} triggered ${c.bold(taskId)} ${res.runId ? c.gray(`→ ${res.runId}`) : ""}`);
  else out(`${sym.fail} ${c.red(res.error ?? "run failed")}`);
}

async function cmdStatus(useJson: boolean): Promise<void> {
  const client = makeClient();
  const [me, jobs, failures] = await Promise.all([
    client.account.me(),
    client.jobs.list(),
    client.runs.list({ limit: 5, status: "failed" }),
  ]);
  if (useJson) return json({ me, jobs, recentFailures: failures.runs });
  const totalTasks = jobs.reduce((n, j) => n + j.taskCount, 0);
  const activeTasks = jobs.reduce((n, j) => n + j.activeTaskCount, 0);
  const errorTasks = jobs.reduce((n, j) => n + j.errorTaskCount, 0);
  const healthy = errorTasks === 0 && me.summary.openDlqCount === 0;
  header("status");
  out(`${healthy ? sym.ok : sym.warn} ${healthy ? c.green("healthy") : c.yellow("needs attention")}`);
  out();
  out(`  ${c.dim("containers")}  ${jobs.length}`);
  out(`  ${c.dim("tasks")}       ${activeTasks}/${totalTasks} active${errorTasks ? c.red(` · ${errorTasks} errored`) : ""}`);
  out(`  ${c.dim("open DLQ")}    ${me.summary.openDlqCount ? c.red(String(me.summary.openDlqCount)) : c.gray("0")}`);
  out(`  ${c.dim("executions")}  ${me.usage.executionCount} this period`);
  if (failures.runs.length) {
    out();
    out(c.dim("  recent failures:"));
    const now = Date.now();
    for (const r of failures.runs) out(`   ${sym.fail} ${c.bold(r.taskName)} ${c.gray(r.jobName)} ${relativeTime(r.startedAt, now)} ${r.error ? c.red(truncate(r.error, 50)) : ""}`);
  }
}

async function cmdSync(positionals: string[], flags: Args["flags"], useJson: boolean): Promise<void> {
  const app = await loadApp(positionals[0]);
  const dryRun = !!flags["dry"] || !!flags["dry-run"];
  const result = await app.sync({ dryRun });
  if (useJson) return json(result);
  out(formatSyncResult(result, { color: true, dryRun }));
}

/**
 * `cronvello dev [entry]` — start the **local engine**: load the config module and actually run the
 * jobs on this machine (no account, no cloud). `--dry-run` prints what would fire in the next window
 * instead of executing anything. Runs until SIGINT, then shuts down cleanly.
 */
async function cmdDevEngine(positionals: string[], flags: Args["flags"], useJson: boolean): Promise<void> {
  const app = await loadApp(positionals[0]);
  const dryRun = !!flags["dry-run"] || !!flags["dry"];

  if (dryRun) {
    const engine = app.dev({ autoStart: false, installSignalHandlers: false });
    const windowMs = parseDurationFlag(flags["window"], 60 * 60 * 1000);
    const maxPerJob = 50;
    const fires = upcomingFires(
      engine.jobs().map((j) => ({ key: j.key, schedule: j.schedule, timeZone: j.timeZone })),
      { withinMs: windowMs, maxPerJob },
    );
    // Be honest when a high-frequency schedule hit the per-job cap — the window isn't fully shown.
    const cappedJobs = [...new Set(fires.map((f) => f.key))].filter(
      (key) => fires.filter((f) => f.key === key).length >= maxPerJob,
    );
    if (useJson) {
      return json({
        window: { ms: windowMs },
        capped: cappedJobs,
        fires: fires.map((f) => ({ key: f.key, time: f.time.toISOString(), schedule: f.schedule, timeZone: f.timeZone })),
      });
    }
    header(`dev · dry-run · next ${formatDuration(windowMs)}`);
    out(renderUpcoming(fires));
    out();
    out(c.gray(fires.length ? `${fires.length} fire(s) would run — no handlers were executed` : "nothing scheduled in this window"));
    if (cappedJobs.length) {
      out(c.yellow(`▲ output capped at ${maxPerJob} per job (${cappedJobs.join(", ")}) — high-frequency schedule, not the full window`));
    }
    return;
  }

  const engine = app.dev({ autoStart: false, installSignalHandlers: false, onEvent: (e) => renderEvent(e, useJson) });

  // Start first so the snapshot has each job's computed next-fire time, then print the table.
  engine.start();

  // Optional local dashboard. Loaded lazily so it never weighs on the non-dashboard path.
  let dashboardUrl: string | undefined;
  if (flags["dashboard"]) {
    const { startDashboard } = await import("../dev/dashboard.js");
    const port = typeof flags["port"] === "string" ? Number.parseInt(flags["port"], 10) : undefined;
    const host = typeof flags["host"] === "string" ? flags["host"] : undefined;
    try {
      const dash = await startDashboard(engine, { port, host });
      dashboardUrl = dash.url;
      engine.onStop(() => dash.close()); // Ctrl-C → engine.stop() tears the dashboard down too.
    } catch (err) {
      await engine.stop();
      throw err; // surfaced cleanly (e.g. "port … already in use") by run()'s catch
    }
  }

  if (!useJson) {
    header(`dev · local engine ${c.gray("· no account, no cloud")}`);
    out(renderSchedule(engine.snapshot()));
    out();
    if (dashboardUrl) out(`${sym.ok} dashboard → ${c.cyan(dashboardUrl)}`);
    out(c.gray(`watching ${engine.jobs().length} job(s) — press Ctrl-C to stop`));
    out();
  }

  // Block until interrupted, then drain in-flight runs and print a short summary.
  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      void engine.stop().then(resolve);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });

  if (!useJson) {
    out();
    const runs = engine.runs();
    const ok = runs.filter((r) => r.status === "success").length;
    const bad = runs.filter((r) => r.status === "error" || r.status === "timed_out").length;
    out(c.gray(`stopped — ${runs.length} run(s) this session (${ok} ok${bad ? `, ${c.red(`${bad} failed`)}` : ""})`));
  }
}

/** `cronvello trigger [entry] <jobKey>` — run a single job's handler once, locally (no deploy). */
async function cmdTrigger(positionals: string[], useJson: boolean): Promise<void> {
  // Last positional is the job key; an optional earlier one is the config path.
  const jobKey = positionals[positionals.length - 1];
  const configPath = positionals.length >= 2 ? positionals[0] : undefined;
  if (!jobKey) throw new CronvelloConfigError("Usage: cronvello trigger [configPath] <jobKey>");
  const app = await loadApp(configPath);
  if (!app.keys().includes(jobKey)) {
    throw new CronvelloConfigError(`Unknown job "${jobKey}". Known: ${app.keys().join(", ") || "(none)"}`);
  }
  if (!useJson) out(`${sym.arrow} running ${c.bold(jobKey)} locally…`);
  const started = Date.now();
  const result = await app.trigger(jobKey);
  if (useJson) return json({ job: jobKey, result });
  out(`${sym.ok} ${c.bold(jobKey)} ${c.gray(`done in ${Date.now() - started}ms`)}`);
  if (result !== undefined && result !== null) {
    out(c.dim("  result:"));
    out(JSON.stringify(result, null, 2).split("\n").map((l) => "  " + l).join("\n"));
  }
}

/** `cronvello preview "<cron>" [--tz <IANA>] [-n 5]` — print the next N fire times of an expression. */
function cmdPreview(positionals: string[], flags: Args["flags"], useJson: boolean): void {
  const expr = positionals[0];
  if (!expr) throw new CronvelloConfigError('Usage: cronvello preview "<cron>" [--tz <IANA>] [-n 5]');
  const tz = typeof flags["tz"] === "string" ? flags["tz"] : localTimeZone();
  const count = clampLimit(flags["n"] ?? flags["count"] ?? flags["limit"]);

  let times: Date[];
  try {
    times = previewSchedule(expr, { timeZone: tz, count });
  } catch (err) {
    throw new CronvelloConfigError(err instanceof Error ? err.message : String(err));
  }

  if (useJson) return json({ schedule: expr, timeZone: tz, next: times.map((t) => t.toISOString()) });
  header(`preview ${c.cyan(expr)} ${c.gray(`· ${tz}`)}`);
  if (!times.length) {
    out(c.gray("no upcoming fire times (does this expression ever match?)"));
    return;
  }
  const now = Date.now();
  out(
    table(
      [{ header: "#", align: "right" }, { header: "LOCAL TIME" }, { header: "WHEN" }, { header: "UTC" }],
      times.map((t, i) => [
        c.gray(String(i + 1)),
        c.bold(formatInZone(t, tz)),
        relativeTime(t.toISOString(), now),
        c.gray(t.toISOString()),
      ]),
    ),
  );
}

// ─── Dev rendering ───────────────────────────────────────────────────────────

/** The schedule table shown when the engine starts. */
function renderSchedule(snapshot: JobSnapshot[]): string {
  const now = Date.now();
  return table(
    [{ header: "JOB" }, { header: "SCHEDULE" }, { header: "TZ" }, { header: "NEXT RUN" }, { header: "WHEN" }],
    snapshot.map((s) => [
      c.bold(s.key),
      c.cyan(s.schedule),
      c.gray(s.timeZone),
      s.nextFire ? formatInZone(s.nextFire, s.timeZone) : c.gray("—"),
      s.nextFire ? relativeTime(s.nextFire.toISOString(), now) : c.gray("—"),
    ]),
  );
}

/** The dry-run table of upcoming fires. */
function renderUpcoming(fires: UpcomingFire[]): string {
  const now = Date.now();
  return table(
    [{ header: "WHEN" }, { header: "LOCAL TIME" }, { header: "JOB" }, { header: "SCHEDULE" }],
    fires.map((f) => [
      relativeTime(f.time.toISOString(), now),
      c.bold(formatInZone(f.time, f.timeZone)),
      c.cyan(f.key),
      c.gray(f.schedule),
    ]),
  );
}

/** Render one live engine event as a timestamped line (or an NDJSON line under --json). */
function renderEvent(event: EngineEvent, useJson: boolean): void {
  if (useJson) return out(JSON.stringify(event));
  const ts = c.gray(clockStamp(Date.now()));
  switch (event.type) {
    case "fire":
      out(`${ts} ${sym.arrow} ${c.bold(event.key)} ${c.gray(event.attempt > 1 ? `(attempt ${event.attempt})` : "fired")}`);
      break;
    case "success":
      out(`${ts} ${sym.ok} ${c.bold(event.key)} ${c.gray(`${event.durationMs}ms${event.attempts > 1 ? ` · ${event.attempts} attempts` : ""}`)}`);
      break;
    case "error":
      out(`${ts} ${sym.fail} ${c.bold(event.key)} ${c.red(event.error)} ${c.gray(event.willRetry ? "· will retry" : "· gave up")}`);
      break;
    case "timeout":
      out(`${ts} ${sym.fail} ${c.bold(event.key)} ${c.red("timed out")} ${c.gray(`after ${event.durationMs}ms${event.willRetry ? " · will retry" : " · gave up"}`)}`);
      break;
    case "retry":
      out(`${ts} ${sym.warn} ${c.bold(event.key)} ${c.gray(`retrying in ${event.delayMs}ms (attempt ${event.attempt})`)}`);
      break;
    case "skipped":
      out(`${ts} ${sym.warn} ${c.bold(event.key)} ${c.gray("skipped — previous run still in flight")}`);
      break;
    // "scheduled" / "engine-start" / "engine-stop" are intentionally quiet in the live feed.
  }
}

/** Format an instant in an IANA zone as "YYYY-MM-DD HH:MM:SS". */
function formatInZone(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(date);
    const m: Record<string, string> = {};
    for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
    const hour = m["hour"] === "24" ? "00" : m["hour"];
    return `${m["year"]}-${m["month"]}-${m["day"]} ${hour}:${m["minute"]}:${m["second"]}`;
  } catch {
    return date.toISOString();
  }
}

/** Wall-clock HH:MM:SS in the local zone, for live-feed line stamps. */
function clockStamp(nowMs: number): string {
  return formatInZone(new Date(nowMs), localTimeZone()).slice(11);
}

function parseDurationFlag(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(value.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const mult = unit === "s" ? 1000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return n * mult;
}

function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function cmdSecret(useJson: boolean): void {
  const secret = generateDispatchSecret();
  if (useJson) return json({ dispatchSecret: secret });
  out(secret);
}

// ─── Config-module loading (sync / dev) ──────────────────────────────────────

const DEFAULT_CONFIG_PATHS = [
  "cronvello.config.ts", "cronvello.config.js", "cronvello.config.mjs",
  "cronvello.ts", "cronvello.js", "src/cronvello.ts", "src/cronvello.js",
];

function looksLikeApp(v: unknown): v is CronvelloApp {
  return !!v && typeof v === "object" && typeof (v as CronvelloApp).sync === "function" && typeof (v as CronvelloApp).trigger === "function";
}

async function loadApp(pathArg: string | undefined): Promise<CronvelloApp> {
  const candidate = pathArg ?? DEFAULT_CONFIG_PATHS.find((p) => existsSync(resolve(process.cwd(), p)));
  if (!candidate) {
    throw new CronvelloConfigError(
      `No config module found. Pass a path (cronvello sync ./cronvello.config.js) or add one of: ${DEFAULT_CONFIG_PATHS.join(", ")}.`,
    );
  }
  const abs = resolve(process.cwd(), candidate);
  if (!existsSync(abs)) throw new CronvelloConfigError(`Config module not found: ${abs}`);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unknown file extension|\.ts|ERR_UNKNOWN/.test(msg) && abs.endsWith(".ts")) {
      throw new CronvelloConfigError(
        `Could not import a TypeScript config directly. Run the CLI under a TS loader, e.g.\n  node --import tsx node_modules/@cronvello/sdk/dist/cli.js sync ${candidate}\nor point at a compiled .js file.`,
      );
    }
    throw new CronvelloConfigError(`Failed to import ${candidate}: ${msg}`);
  }

  const found = looksLikeApp(mod["default"]) ? mod["default"]
    : looksLikeApp(mod["cronvello"]) ? mod["cronvello"]
    : looksLikeApp(mod["app"]) ? mod["app"]
    : Object.values(mod).find(looksLikeApp);
  if (!found) {
    throw new CronvelloConfigError(`${candidate} does not export a Cronvello app (export default defineCronvello({…}) or a named \`cronvello\`).`);
  }
  return found as CronvelloApp;
}

// ─── Help / dispatch ─────────────────────────────────────────────────────────

function printHelp(): void {
  out(`${ICON} ${brand("Cronvello")} ${c.gray("· code-first cron")}  ${c.dim("v" + VERSION)}`);
  out();
  out(c.bold("USAGE"));
  out(`  ${c.cyan("cronvello")} <command> [options]`);
  out();
  out(c.bold("COMMANDS"));
  const cmds: [string, string][] = [
    ["whoami", "account, plan, limits & usage"],
    ["list [jobName]", "job containers, or tasks inside one"],
    ["tasks [--job <name>]", "account-wide task table"],
    ["runs [--limit n] [--status s]", "recent execution feed"],
    ["run <taskId>", "trigger a task now (or: run <jobName> <taskName>)"],
    ["status", "health overview + recent failures"],
    ["sync [path] [--dry]", "reconcile a code registry (loads your module)"],
    ["dev [path] [--dry-run]", "start the local engine — run jobs locally, no account"],
    ["dev --dashboard [--port n]", "…plus a local web dashboard (127.0.0.1, live runs + run-now)"],
    ["preview \"<cron>\" [-n 5]", "print the next N fire times (--tz <IANA>)"],
    ["trigger [path] <jobKey>", "run a single job handler once, locally"],
    ["secret", "generate a strong dispatch secret"],
  ];
  for (const [name, desc] of cmds) out(`  ${c.cyan(name.padEnd(30))} ${c.gray(desc)}`);
  out();
  out(c.bold("GLOBAL"));
  out(`  ${c.cyan("--json".padEnd(30))} ${c.gray("machine-readable output")}`);
  out(`  ${c.cyan("--no-color".padEnd(30))} ${c.gray("disable colour")}`);
  out(`  ${c.cyan("-h, --help".padEnd(30))} ${c.gray("show this help")}`);
  out(`  ${c.cyan("-v, --version".padEnd(30))} ${c.gray("print version")}`);
  out();
  out(c.gray("Auth: export CRONVELLO_API_KEY (crn_live_…). Optional: CRONVELLO_API_URL."));
}

function clampLimit(v: string | boolean | undefined): number {
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags["no-color"]) setColor(false);
  const useJson = !!args.flags["json"];

  if (args.flags["version"] || args.flags["v"]) {
    out(VERSION);
    return 0;
  }
  if (!args.command || args.flags["help"] || args.flags["h"] || args.command === "help") {
    printHelp();
    return 0;
  }

  try {
    switch (args.command) {
      case "whoami": await cmdWhoami(useJson); break;
      case "list": await cmdList(args.positionals[0], useJson); break;
      case "tasks": await cmdTasks(args.flags, useJson); break;
      case "runs": await cmdRuns(args.flags, useJson); break;
      case "run": await cmdRun(args.positionals, useJson); break;
      case "status": await cmdStatus(useJson); break;
      case "sync": await cmdSync(args.positionals, args.flags, useJson); break;
      case "dev": await cmdDevEngine(args.positionals, args.flags, useJson); break;
      case "preview": cmdPreview(args.positionals, args.flags, useJson); break;
      case "trigger": await cmdTrigger(args.positionals, useJson); break;
      case "secret": cmdSecret(useJson); break;
      default:
        out(`${sym.fail} Unknown command "${args.command}". Run ${c.cyan("cronvello --help")}.`);
        return 1;
    }
    return 0;
  } catch (err) {
    if (err instanceof CronvelloApiError) {
      out(`${sym.fail} ${c.red(`API ${err.status}`)} ${err.message}${err.isRateLimited && err.retryAfterSeconds ? c.gray(` (retry in ${err.retryAfterSeconds}s)`) : ""}`);
    } else if (err instanceof CronvelloConfigError) {
      out(`${sym.fail} ${err.message}`);
    } else {
      out(`${sym.fail} ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

/**
 * True when this module is the process entry point — including when launched through the `bin`
 * symlink (`node_modules/.bin/cronvello`), where `process.argv[1]` is the symlink path. Resolving
 * both sides through `realpathSync` makes the comparison symlink-proof; under a test runner the
 * entry is the runner, so this is false and importing the module never auto-runs.
 */
function isMainModule(): boolean {
  try {
    const argv1 = process.argv?.[1];
    if (!argv1) return false;
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // Exit quietly when the reader closes the pipe early (e.g. `cronvello list | head`).
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
