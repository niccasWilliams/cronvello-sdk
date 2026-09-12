# @cronvello/sdk

[![npm](https://img.shields.io/npm/v/@cronvello/sdk)](https://www.npmjs.com/package/@cronvello/sdk)
[![CI](https://github.com/niccasWilliams/cronvello-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/niccasWilliams/cronvello-sdk/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@cronvello/sdk)](./LICENSE)

**Code-first cron jobs.** Declare your scheduled jobs in your codebase and run them: with a real
scheduler on your own machine, and optionally with [Cronvello](https://cronvello.com) hosting them.
**No dashboard required.** Your jobs always follow your code.

## Try it without an account

Three steps, no signup, nothing leaves your machine:

```bash
npm i @cronvello/sdk
```

```js
// cronvello.config.mjs
import { defineCronvello, every } from "@cronvello/sdk";

export default defineCronvello({
  appName: "my-app",
  jobs: {
    heartbeat: { schedule: every("10s"), handler: async () => console.log("beat") },
  },
});
```

```bash
npx cronvello dev
```

That starts an actual scheduler loop: each next fire time computed from the cron expression,
timezone- and DST-aware, with overlap protection, per-run timeouts and retry with backoff. It makes
no network calls. This part is MIT licensed and works standalone. See
[Local development](#local-development-no-account--cronvello-dev) for the full output.

The hosted side adds what a local loop can't: run history, retries you can inspect, alerts when a
run *doesn't* happen, and replay. It's opt-in, and only the calls that use it (`sync()`, `run()`,
the dispatch handler) need credentials.

---

- ✅ **Runs locally with no account** — `npx cronvello dev` starts a real scheduler loop on your
  machine (timezone/DST, overlap protection, timeouts, retry/backoff). No cloud, no network.
- ✅ **Zero runtime dependencies** (Node 20+ `fetch` + WebCrypto).
- ✅ **Dual ESM + CJS**, full TypeScript types.
- ✅ **Base URL baked in** (`https://api.cronvello.com`) — override only for self-hosting.
- ✅ **Two layers**: a turnkey code-first **registry**, and a typed **low-level client** for the
  full `/v1` API.
- ✅ **Readable schedules** — `daily("08:00")`, `every("15m")`, `weekly("mon", "09:00")` instead of
  raw cron — with **typo-proof validation** at define time.
- ✅ **Test jobs locally** with `cronvello.trigger("job")` — no deploy, no HTTP.
- ✅ **Lifecycle hooks** for logging / metrics / error reporting.
- ✅ **A real CLI** — `npx cronvello dev | preview | whoami | list | runs | status | sync`.

---

## A runnable failure-and-recovery demo

Try the [local demo](https://github.com/niccasWilliams/cronvello-sdk/tree/main/examples/local): three jobs show a successful run, a deliberate failure
with retry, and overlap protection in the local dashboard. It uses plain JavaScript, needs
no account, and does not call external services.

## The idea (hosted)

You declare jobs once, in code. On every deploy you call `sync()`, and the SDK reconciles your
registry into Cronvello: **one Cronvello "job" container for your app, one task per registry
entry.** When a task is due, Cronvello calls your app back over HTTPS; the SDK's mounted handler
verifies the call and runs the right job. Add a job → it appears. Remove a job → it's pruned.
Change a schedule → it's updated. Idempotent, every time.

---

## Hosted quick start (Express)

> Needs a Cronvello account. To stay local, skip to
> [Local development](#local-development-no-account--cronvello-dev).

```ts
// cronvello.ts
import { defineCronvello, daily, every } from "@cronvello/sdk";

// `fromEnv` reads CRONVELLO_API_KEY, CRONVELLO_DISPATCH_SECRET, and CRONVELLO_APP_URL
// (or PUBLIC_URL) for you — pass them explicitly instead if you prefer.
export const cronvello = defineCronvello.fromEnv({
  appName: "my-app", // your app's identity (stable, unique)

  jobs: {
    "send-daily-digest": {
      schedule: daily("08:00"),                 // ← readable; or a raw "0 8 * * *"
      handler: async () => {
        await sendDigests();
      },
    },
    "cleanup-temp": {
      schedule: every("15m"),
      description: "Purge temp files older than an hour",
      handler: async ({ schedule, logger }) => {
        const removed = await purgeTemp();
        logger.info?.(`purged ${removed} files`);
        return { removed, schedule };           // returned value is recorded on the run
      },
    },
  },
});
```

```ts
// server.ts
import express from "express";
import { cronvello } from "./cronvello";

const app = express();

// Mount the dispatch endpoint Cronvello calls when a job is due.
app.post(cronvello.dispatchPath, express.json(), cronvello.expressHandler());

app.listen(3000, async () => {
  // Reconcile the registry → Cronvello. Safe to run on every boot/deploy.
  const result = await cronvello.sync();
  console.log(`Cronvello synced: +${result.created} ~${result.updated} -${result.deleted}`);
});
```

That's it. No dashboard clicks. The jobs in your code are the jobs that run.

---

## Hosted quick start (Next.js App Router)

```ts
// app/cronvello/dispatch/route.ts
import { cronvello } from "@/lib/cronvello";
export const POST = cronvello.nextHandler();
```

```ts
// scripts/sync-cron.ts  (run in CI / on deploy)
import { cronvello } from "@/lib/cronvello";
await cronvello.sync();
```

> On serverless hosts use the default **sync** execution mode so jobs finish within the request.
> `async_callback` (below) needs a host that keeps running after the HTTP response.

---

## Defining jobs — two styles, your choice

**Keyed object** (the key is the stable identity):

```ts
jobs: {
  "rotate-keys": { schedule: "0 3 * * 0", handler: rotateKeys },
}
```

**Array** (each entry carries its own `key`) — handy when jobs live across modules:

```ts
import { billingJobs } from "./billing/jobs";
import { reportJobs } from "./reports/jobs";

jobs: [...billingJobs, ...reportJobs]   // each: { key, schedule, handler, … }
```

### Job options

| Field | Default | Notes |
|---|---|---|
| `schedule` | — | Cron string or a [schedule builder](#readable-schedules). Validated client-side at define time, and again by Cronvello on sync. |
| `handler` | — | `async (ctx) => result`. The return value is recorded on the run. |
| `description` | — | Stored on the task. |
| `timeZone` | app default (`Europe/Berlin`) | IANA zone. Validated client-side. |
| `urgency` | — | `low` \| `medium` \| `high` \| `critical`. |
| `maxRetries` | server default | 0–20. |
| `executionMode` | `sync` | `async_callback` for long jobs (see below). |
| `callbackTimeoutMs` | — | Async-mode budget before Cronvello marks the run timed out. |
| `allowConcurrentRuns` | `false` | Allow overlap with an in-flight run. |
| `successCriteria` | — | Assert success beyond 2xx (status range, body contains / JSON path / regex). |
| `payload` | — | Static object merged into the request body and exposed as `ctx.payload`. |
| `enabled` | `true` | `false` keeps the code but stops scheduling. |

### The handler context

```ts
handler: async (ctx) => {
  ctx.key;       // "cleanup-temp"
  ctx.schedule;  // "*/15 * * * *"
  ctx.payload;   // your static payload, if any
  ctx.body;      // full request body Cronvello sent
  ctx.isAsync;   // true under async_callback mode
  ctx.source;    // "dispatch" (Cronvello fired it) | "local" (you called trigger())
  ctx.logger;    // your configured logger (no-op if none) — ctx.logger.info?.("…")
  ctx.signal;    // AbortSignal, if the host provides one
};
```

---

## Readable schedules

Stop hand-writing cron. These builders return a validated cron string, so a bad argument throws
**at define time** with a clear message — not silently at the server:

```ts
import { every, everyMinutes, everyHours, hourly, daily, weekly, monthly, weekdays, weekends, cron } from "@cronvello/sdk";

every("30s")              // "*/30 * * * * *"
every("15m")              // "*/15 * * * *"
every("2h")               // "0 */2 * * *"
hourly()                  // "0 * * * *"        — top of every hour
hourly(30)                // "30 * * * *"
daily("08:00")            // "0 8 * * *"
weekly("mon", "09:00")    // "0 9 * * 1"
monthly(1, "00:00")       // "0 0 1 * *"        — 1st of the month
weekdays("07:00")         // "0 7 * * 1-5"      — Mon–Fri
weekends("10:00")         // "0 10 * * 0,6"
cron("0 6,7 * * *")       // raw cron, still validated
```

Validation runs on every job's `schedule` and `timeZone` when you call `defineCronvello`. Opt out
with `validateSchedules: false`. You can also validate directly:

```ts
import { validateCron, isValidTimeZone } from "@cronvello/sdk";
validateCron("0 25 * * *");     // { valid: false, error: 'invalid hour "25": …' }
isValidTimeZone("Europe/Berlin"); // true
```

---

## Test & run jobs locally — `trigger()`

Run a job's handler **in-process** — no HTTP, no Cronvello, no deploy. Perfect for unit tests and
local development:

```ts
const result = await cronvello.trigger("send-daily-digest");
// runs the handler with ctx.source === "local"; lifecycle hooks fire; returns the handler's value
```

```ts
// In a test:
it("sends digests", async () => {
  const out = await cronvello.trigger("send-daily-digest", { dryRun: true });
  expect(out).toEqual({ sent: 3 });
});
```

---

## Local development (no account) — `cronvello dev`

You don't need a Cronvello account, an API key, or a deploy to run your jobs. **The SDK ships a real
local engine.** Point the CLI at the module that exports your app and it starts a scheduler loop on
your machine that actually fires the handlers when they're due — computing each next fire time from
its cron expression (timezone- and DST-aware) and enforcing the same production policies the cloud
does: **overlap protection, per-run timeout, and retry with backoff**. No cloud, no network.

Jobs are the only required config. `apiKey`, `appUrl` and `dispatchSecret` belong to the hosted
side, and nothing local asks for them:

```ts
// cronvello.config.ts
import { defineCronvello, every, daily } from "@cronvello/sdk";

export const cronvello = defineCronvello({
  appName: "my-app",
  timeZone: "Europe/Berlin",
  jobs: {
    heartbeat:      { schedule: every("10s"), handler: async () => { console.log("beat"); } },
    "daily-digest": { schedule: daily("08:00"), handler: async () => sendDigests() },
  },
});
```

```bash
npx cronvello dev                    # auto-detects cronvello.config.{ts,js,mjs} (or pass a path)
```

```
◷ Cronvello dev · local engine · no account, no cloud

JOB           SCHEDULE       TZ             NEXT RUN             WHEN
heartbeat     */10 * * * * *  Europe/Berlin  2026-06-28 18:03:10  in 8s
daily-digest  0 8 * * *      Europe/Berlin  2026-06-29 08:00:00  in 14h

watching 2 job(s) — press Ctrl-C to stop

18:03:10 → heartbeat fired
18:03:10 ✔ heartbeat 3ms
18:03:20 → heartbeat fired
18:03:20 ✔ heartbeat 2ms
```

Every fire is logged with its result, duration, retries, and any timeouts; the engine keeps an
in-memory history of recent runs and shuts down cleanly on `Ctrl-C`. Running a **TypeScript** config
directly? Launch the CLI under a TS loader:

```bash
node --import tsx node_modules/@cronvello/sdk/dist/cli.js dev ./cronvello.config.ts
```

**See what would fire without running anything:**

```bash
npx cronvello dev --dry-run --window 1h     # lists the fires due in the next hour
```

**Preview any cron expression** — the next N fire times, in a timezone:

```bash
npx cronvello preview "0 8 * * 1-5" --tz Europe/Berlin -n 5
npx cronvello preview "@daily" -n 3
```

**Run a single job once** (handy in a script or while iterating on one handler):

```bash
npx cronvello trigger daily-digest
```

### Local dashboard

Prefer to *see* your schedule? Add `--dashboard` and `cronvello dev` also serves a small local web UI
on top of the same engine — no account, no cloud, no external network.

```bash
npx cronvello dev --dashboard            # → http://127.0.0.1:4747  (override with --port)
```

Open the printed URL and you get, live:

- a **summary** across the session: jobs, runs, how many succeeded, how many failed, and what fires
  next,
- a **timeline** with one lane per job, plotting the runs that already happened next to the fires
  still to come, around a now-line that moves as you watch. A schedule that is wrong is usually
  obvious here before it is obvious anywhere else,
- every **job** with its cron expression, timezone, and a **countdown to the next fire**,
- a **run feed** that streams each fire, success, error, timeout, retry, and skip as it happens, with
  a pause that tells you how much you're missing,
- a **job drawer** with the next fire times and recent runs, each one carrying its **error message**
  or its **returned value**, plus a **Run now** button that triggers the handler through the engine,
- light + dark, keyboard-reachable rows, and an honest **reconnecting** state if the engine stops.

It binds to `127.0.0.1` by default (it's a dev tool, not a public server) and exposes a tiny
read-only JSON API plus an SSE stream — `GET /api/state` for everything the page draws, and
`GET /api/runs.ndjson` to pipe the run history out as NDJSON. You can also start it
programmatically:

```ts
const engine = cronvello.dev({ dashboard: true });   // or { dashboard: { port: 5000 } }
// … engine.stop() closes the dashboard too.
```

![Cronvello local dashboard](https://unpkg.com/@cronvello/sdk/docs/dashboard.png)

### Embedding the engine

`cronvello dev` is a thin wrapper over `app.dev()`, which you can call yourself — it returns the
engine handle (run history, snapshot, clean `stop()`):

```ts
const engine = cronvello.dev();          // starts the local scheduler
// … later …
console.log(engine.runs());              // recent run records, newest first
await engine.stop();                     // drains in-flight runs, clears timers
```

The lower-level primitives live under the **`@cronvello/sdk/dev`** subpath — including
`nextOccurrence`, `previewSchedule`, and `createLocalEngine` — so you can build the schedule math
into your own tooling:

```ts
import { nextOccurrence, previewSchedule } from "@cronvello/sdk/dev";

nextOccurrence("0 8 * * *", { timeZone: "Europe/Berlin" });  // → next 08:00 in Berlin
previewSchedule("*/15 * * * *", { count: 4 });               // → the next four fire times
```

> The local engine is fully MIT and **never makes a network call**. When your jobs are ready for
> production, `sync()` registers the exact same definitions with Cronvello Cloud — same code, now
> hosted, with reliability, alerts, and run history. Local is the on-ramp; the cloud is the upsell.

---

## Lifecycle hooks & logging

Observe every run — for structured logs, metrics, or error reporting (Sentry, etc.). Hooks never
break a run: if a hook throws, it's logged and the job still completes.

```ts
defineCronvello.fromEnv({
  appName: "my-app",
  logger: console, // surfaced to handlers as ctx.logger
  hooks: {
    onJobStart:   ({ key, source })            => metrics.increment(`cron.start`, { key }),
    onJobSuccess: ({ key, durationMs })        => metrics.timing(`cron.ms`, durationMs, { key }),
    onJobError:   ({ key, error })             => Sentry.captureException(error, { tags: { key } }),
  },
  jobs: { /* … */ },
});
```

---

## Pretty sync output

```ts
import { formatSyncResult } from "@cronvello/sdk";

const result = await cronvello.sync();
console.log(formatSyncResult(result, { color: true }));
// Cronvello synced "my-app" (job_…)
//   + created   send-daily-digest
//   ~ updated   cleanup-temp (schedule)
//   = unchanged rotate-keys
//   1 created, 1 updated, 1 unchanged
```

---

## `sync()` — idempotent reconcile

```ts
const result = await cronvello.sync();
// { jobId, jobName, jobCreated, created, updated, unchanged, deleted, skipped, changes[] }
```

- Ensures one Cronvello **job container** named `appName`.
- For each registry job: **creates** it (and starts it — Cronvello creates tasks disabled),
  **patches** it when the schedule/options changed, or leaves it **unchanged**.
- **Prunes** tasks in the container that are no longer in your registry (`prune: false` to keep them).
- `dryRun: true` returns the diff without touching anything.

Under the hood `sync()` does this in a **single server-side call** (`PUT /v1/registry`) when the
API supports it, and transparently falls back to a client-side diff against older servers — you
don't need to care which path ran.

```ts
await cronvello.sync({ dryRun: true });   // preview
await cronvello.sync({ prune: false });   // never delete
await cronvello.sync({ rotateSecret: true }); // re-write the dispatch secret on every task
```

Only tasks inside **your** app's container are ever touched — anything else in your account is
left alone.

### Trigger a job now

```ts
await cronvello.run("send-daily-digest");   // manual one-off run via Cronvello
```

---

## Security model

Cronvello calls your dispatch endpoint with `Authorization: Bearer <dispatchSecret>`. The mounted
handler verifies it in **constant time** before running anything. Generate a strong secret once:

```bash
node -e "console.log(require('@cronvello/sdk').generateDispatchSecret())"
```

Store it as `CRONVELLO_DISPATCH_SECRET` in both your app env and nowhere else — `sync()` registers
it with Cronvello as the task's bearer token (encrypted at rest; never returned on read).

An app defined without a `dispatchSecret` has no HTTP entry point to protect, so `expressHandler()`
and `nextHandler()` refuse to be mounted at all, and a dispatch that somehow reaches `handle()` is
rejected. There is no configuration in which an unauthenticated request runs a job.

---

## Long-running jobs — `async_callback`

For work that exceeds the request timeout, set `executionMode: "async_callback"`. The handler
returns immediately with `202`, runs in the background, and the SDK posts the result back to
Cronvello (HMAC-signed). Use only on a host that keeps executing after the response (a
long-running Node server — **not** typical serverless).

```ts
"rebuild-search-index": {
  schedule: "0 4 * * *",
  executionMode: "async_callback",
  callbackTimeoutMs: 600_000,
  handler: async () => { await rebuildIndex(); },
}
```

---

## CLI — `npx cronvello`

Installing the SDK gives you a `cronvello` command. Point it at your account with
`CRONVELLO_API_KEY` (a `crn_live_…` key) and inspect or drive everything from the terminal:

```bash
export CRONVELLO_API_KEY=crn_live_…

npx cronvello whoami                  # account, plan, limits & usage
npx cronvello list                    # job containers (tasks / active / errors)
npx cronvello list "my-app"           # the tasks inside one container
npx cronvello tasks --job "my-app"    # account-wide task table
npx cronvello runs --limit 20         # recent execution feed
npx cronvello runs --status failed    # …filtered
npx cronvello run <taskId>            # trigger a task now
npx cronvello run "my-app" "digest"   # …resolved by job + task name
npx cronvello status                  # health overview + recent failures
npx cronvello secret                  # generate a strong dispatch secret
```

```
$ cronvello whoami
╭─ Acme Production ──────────────────────────────╮
│ account   #42  ✔ ops@example.com               │
│ plan      Pro                                  │
│ limits    100 jobs · 50 tasks/job · 600/min    │
│ usage     1842 / 10000 executions  (4 jobs)    │
│ attention 0 DLQ · 0 heartbeats · 0 maintenance │
╰────────────────────────────────────────────────╯
```

**Drive your code registry**, too — these load your config module (a file that exports a
`defineCronvello(...)` app as the default export or a named `cronvello`):

```bash
npx cronvello sync ./cronvello.config.js          # reconcile to Cronvello
npx cronvello sync ./cronvello.config.js --dry     # preview the diff
npx cronvello dev  ./cronvello.config.js           # run the jobs locally (the local engine)
npx cronvello dev  ./cronvello.config.js --dry-run # …or just show what would fire
npx cronvello preview "0 8 * * 1-5" --tz Europe/Berlin -n 5   # next fire times of an expression
npx cronvello trigger ./cronvello.config.js my-job # run one job's handler once, locally
```

> Running a **TypeScript** config? Launch the CLI under a TS loader:
> `node --import tsx node_modules/@cronvello/sdk/dist/cli.js sync ./cronvello.config.ts`

Global flags: `--json` (machine-readable output for scripting), `--no-color`, `-h/--help`,
`-v/--version`. Colour auto-disables when piped or when `NO_COLOR` is set.

---

Runnable examples live in [`examples/`](./examples): a full Express app (`examples/express`) and a
Next.js App Router setup (`examples/next`).

---

## Low-level client

The full typed `/v1` surface, for anything beyond the registry model:

```ts
import { CronvelloClient } from "@cronvello/sdk";

const cv = new CronvelloClient({ apiKey: process.env.CRONVELLO_API_KEY! });

const jobs = await cv.jobs.list();
const job = await cv.jobs.create({ name: "adhoc" });
const task = await cv.jobs.createTask(job.id, {
  name: "ping",
  schedule: "* * * * *",
  targetUrl: "https://example.com/ping",
});
await cv.tasks.start(task.id);

const runs = await cv.runs.list({ limit: 20 });
const me = await cv.account.me();
```

Endpoints not yet wrapped (heartbeat monitors, maintenance windows, DLQ, notification channels,
audit log, API-key self-service, analytics) are reachable via the escape hatch:

```ts
const monitors = await cv.request("GET", "/v1/heartbeat-monitors");
```

### Errors

```ts
import { CronvelloApiError } from "@cronvello/sdk";

try {
  await cv.jobs.get("missing");
} catch (e) {
  if (e instanceof CronvelloApiError) {
    e.status;             // 404
    e.isNotFound;         // true
    e.isRateLimited;      // false
    e.retryAfterSeconds;  // set on 429
  }
}
```

Transient failures (429 / 5xx / network) are retried automatically with backoff.

---

## Operator client

You do not need this to *use* Cronvello. It is the backend-to-backend surface for the service
that **provisions apps into** Cronvello — registering them, checking their registration, minting
new per-app tokens, removing them.

It is a separate class on purpose. It runs against the same host as `/v1`, but it takes
Cronvello's **service key**, which is authorized across every registered app — far broader than
an account `apiKey`. Two classes with two differently named options means you cannot send the
wrong credential by accident.

```ts
import { CronvelloAdminClient } from "@cronvello/sdk";

const admin = new CronvelloAdminClient({ serviceKey: process.env.CRONVELLO_SERVICE_KEY! });

// Idempotent upsert, keyed on the string appId. Re-run it on every provisioning pass.
const app = await admin.externalApps.register({
  appId: "node-shop",
  name: "Shop",
  base_url: "https://shop.example.com",
  generateApiKey: true,
});
app.generatedApiKey;  // plaintext, exactly ONCE, and only for a newly created app

const status = await admin.externalApps.status("node-shop");
// { registered, isActive, isLive, lastSyncedAt, jobCount }

// Drift recovery when the current token is lost. Invalidates the old one.
const { newApiKey } = await admin.externalApps.rotateKey("node-shop");

// Takes the NUMERIC app id, not the string appId — an asymmetry in the server contract.
await admin.externalApps.delete(app.id);
```

Cross-field rules (`base_url` or `targetUrl`; a key or `generateApiKey`; both OAuth credentials)
are checked before the request leaves, so a bad call raises `CronvelloConfigError` synchronously
rather than returning an opaque 400. Everything else — errors, retries, envelope handling —
behaves exactly as the low-level client above.

---

## License

MIT
