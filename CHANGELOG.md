# Changelog

## 0.7.0 - 2026-09-07

- Add `externalApps.list()`: every registration this Cronvello instance holds, each with its
  numeric `registrationId`. The other four admin methods all answer about an app you already
  name, so a caller's picture was only ever as complete as its own bookkeeping — one operator
  held 3 of 8 registrations and had no way to notice. Requires a Cronvello server from
  2026-09-07 or later.
- Add `cronvelloCapabilities()`: what this service offers a connection manager, read from the
  admin client's own method table rather than a maintained list. Capabilities that are absent
  name the reason instead of quietly reading `false`.
- Export `ExternalAppsResource` so the capability report can read its prototype.

All notable changes to `@cronvello/sdk` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: minor-feature additions ship as patch releases).

## 0.6.0

**A registration can now be addressed by something that does not change.** `externalApps.status()`
finds an app by its string `appId` — a caller-chosen label. Labels get renamed. When one did, the
lookup answered `registered: false` for a connection that was delivering jobs the entire time, and
the operator on the other end saw a dead edge for days with nothing actually wrong with it. A
rename and a deletion looked identical, so there was no way to tell them apart.

### Added

- **`externalApps.statusByRegistrationId(id)`** — the same status, addressed by the numeric
  `ExternalApp.id` that `register()` hands back. It survives a rename. Like `delete()`, it rejects
  a string `appId` locally: passing the stale label to the method built to outlive it would defeat
  the point.
- **`ExternalAppStatus.appId`** — the label the server currently files the row under, or `null`
  when it is not registered. Read it after a lookup by id to notice that your own copy of the name
  has gone stale, and repair it instead of concluding the app is gone.

Additive only. `statusByRegistrationId()` requires a Cronvello server from 2026-09-06 or later; an
older one has no such route and answers 404 (`CronvelloApiError`, `isNotFound`), which is distinct
from a present route reporting an unknown id — that is a 200 with `registered: false`. Against an
older server `appId` is simply absent from the response.

## 0.5.0

**`externalApps.status()` now answers the question an operator actually has: is this registration
still backed by a usable secret?** It used to return registration and liveness only — five fields,
none of them about the credential. The only responses carrying that information were `register()`
and `rotateKey()`: an upsert and a key mint. A health check built on either one writes on every
pass, and `rotateKey()` invalidates the very token it was asked about. So the read-only question
had no read-only answer.

### Added

- **`ExternalAppStatus.authMethod`, `.hasApiKey`, `.apiKeyMasked`, `.hasOAuthClientSecret` and
  `.lastHealthCheckAt`.** The *state* of the credential, never its value. `apiKeyMasked` is enough
  to tell two secrets apart across calls and never enough to use one.
- `registered: true` with `hasApiKey: false` is now an expressible — and real — state: a
  registration that outlived its secret. Previously it was indistinguishable from a healthy one.

Additive only; every field that existed before is unchanged. Requires a Cronvello server from
2026-09-05 or later — against an older one the new fields are simply absent.

## 0.4.0

### Added

- **`CronvelloAdminClient`** — the operator surface for `/external-apps/service/*`
  (`register`, `status`, `rotateKey`, `delete`). Deliberately a separate class from
  `CronvelloClient`: the service key authorizes across every registered app while an account key
  authorizes one, and two differently named options (`serviceKey` vs `apiKey`) make sending the
  wrong one impossible to express.

## 0.3.0

**Credentials are no longer part of defining jobs.** 0.2.0 made the SDK run locally with no account,
but `defineCronvello()` still demanded an `apiKey`, an `appUrl` and a `dispatchSecret` before it
would construct anything. So the documented way to try the local engine was to invent a fake API
key for a scheduler that never makes a network call. That was real config standing in for no real
constraint, and it landed on exactly the people the local mode is meant to attract.

### Changed

- **`apiKey`, `appUrl` and `dispatchSecret` are now optional.** `defineCronvello({ appName, jobs })`
  is a complete, valid app. `cronvello dev`, `dev()` and `trigger()` work on it unchanged.
- **The hosted side validates where it is used, not at define time.** `sync()`, `run()`, `client`,
  `dispatchUrl`, `expressHandler()` and `nextHandler()` each check what they actually need and throw
  a `CronvelloConfigError` naming every missing field. `client` is now built on first access rather
  than eagerly.
- A *present* but malformed value is still rejected at define time (`appUrl` must be absolute
  http(s), `dispatchSecret` at least 16 chars). This removes a requirement, not a check.

### Added

- **`app.isCloudConfigured`** — true when `apiKey`, `appUrl` and `dispatchSecret` are all present.
- **A rebuilt local dashboard.** The old page answered "what are my jobs" but not "is this healthy",
  so you had to read a log to find out. It now opens on a summary (jobs, runs, succeeded, failed,
  next fire) and a **timeline**: one lane per job, past runs plotted against upcoming fires around a
  moving now-line. A schedule that is wrong shows up there immediately.
  - Run detail now includes the **error message** or the **returned value**, which is the thing you
    opened the panel for.
  - The feed can be paused, and says how many events it is holding back.
  - Rows are keyboard-reachable, Escape closes the drawer and returns focus.
  - The page is driven by one `/api/state` snapshot instead of a fetch per event, and the timeline
    advances by translating a fixed track rather than repositioning every mark each second.
- **`GET /api/state`** on the dashboard server: jobs (with last run and upcoming fires), run history
  and engine state in one response.
- **`engine.startedAt`** and **`engine.running`** on `LocalEngine`.

### Fixed

- The dashboard's job table stayed on "Loading" forever when the registry was empty, because
  "no jobs" and "not loaded yet" looked identical to it.
- A `scheduled` event carries the *next fire time* as its timestamp, which the feed printed in its
  clock column and so appeared to jump forward in time. It now reads "scheduled for HH:MM:SS" and
  the clock column is strictly arrival time.

### Security

- An app without a `dispatchSecret` never runs a job from an HTTP request. `expressHandler()` and
  `nextHandler()` throw at mount time rather than exposing a route, and `handle()` answers `500`
  ("Dispatch is not configured") before touching the body. There is no path in which a missing
  secret degrades into accepting unauthenticated dispatches.

### Compatibility

Backwards compatible: every config valid in 0.2.x is still valid and behaves identically. Minor
rather than patch because the public config type widened and `client` / `dispatchUrl` became lazy.

## 0.2.1

- Move the canonical SDK source to the public
  [`niccasWilliams/cronvello-sdk`](https://github.com/niccasWilliams/cronvello-sdk) repository.
- Add public CI and a tokenless npm Trusted Publishing workflow with automatic provenance.
- Replace internal production-derived contract examples with synthetic fixtures of the same wire
  shape. Runtime behavior and the public API are unchanged.

## 0.2.0

**The SDK now runs locally with no account.** Until now `@cronvello/sdk` was cloud-coupled: jobs
only ran once `sync()` had registered them and Cronvello called your app back. This release adds a
real **local execution engine** and a small **local dashboard**, so the SDK is useful on its own —
`npx cronvello dev` starts a scheduler loop on your machine and actually fires your handlers when
they're due, and `--dashboard` opens a live web UI for them. No account, no network. Everything here
is additive; the cloud `sync()` / dispatch paths are unchanged.

### Added

- **Local engine** — a from-scratch, zero-dependency scheduler. For each job it computes the next
  fire time from its cron expression (5- or 6-field, `@macros`, ranges/lists/steps/names) and runs
  the handler when due, enforcing **timezone/DST**, **overlap protection** (`allowConcurrentRuns`),
  **per-run timeout** (from `callbackTimeoutMs`), and **retry with exponential backoff**
  (`maxRetries`) — locally. Keeps an in-memory run-history ring buffer and shuts down cleanly.
- **`cronvello dev [entry]`** — start the local engine from your config module, with a live job
  table and run feed. `--dry-run [--window <dur>]` prints what would fire in the next window
  without executing anything.
- **`cronvello preview "<cron>" [--tz <IANA>] [-n 5]`** — print the next N fire times of any cron
  expression in a timezone. Also available programmatically as `previewSchedule(expr, opts)`.
- **`app.dev(options?)`** on the object returned by `defineCronvello` — starts the local engine and
  returns its handle (`runs()`, `snapshot()`, `stop()`).
- **`@cronvello/sdk/dev` subpath export** — the engine primitives (`createLocalEngine`,
  `nextOccurrence`, `previewSchedule`, `upcomingFires`, `startDashboard`, types). `nextOccurrence`
  and `previewSchedule` are re-exported from the main entry too.
- **`ctx.signal` on local runs** — the engine aborts it when a run exceeds its timeout, so
  cooperative handlers can cancel their work.
- **Local dashboard** — `cronvello dev --dashboard [--port N]` (or `app.dev({ dashboard: true })`)
  serves a small, zero-dependency web UI over the running engine on `127.0.0.1`: a job table with a
  live next-fire countdown, a Server-Sent-Events run feed (fire/success/error/timeout/retry/skip), a
  per-job drawer with recent runs and upcoming fire times, and a **Run now** button. Read-only JSON
  API plus `GET /api/runs.ndjson` to export the run history. Light + dark, no framework, no network,
  MIT. Mutating requests are same-origin-guarded. The dashboard code is loaded lazily, so it never
  weighs down the main bundle.
- **`engine.subscribe(listener)`**, **`engine.onStop(hook)`**, **`engine.trigger(key)`**, and
  **`engine.toNdjson()`** on `LocalEngine` — the multi-subscriber, manual-run, and export primitives
  the dashboard is built on (`engine.stop()` also tears the dashboard down).

### Changed

- **`cronvello dev <jobKey>` (single-shot) is now `cronvello trigger <jobKey>`** (pre-1.0 rename).
  `cronvello dev` now starts the local engine instead of running one job once. `app.trigger()` is
  unchanged.

## 0.1.4

- **Fix the `cronvello` CLI when launched via the `bin` symlink.** The entry-point check compared
  `process.argv[1]` against the module filename, but when run as `node_modules/.bin/cronvello`
  that argument is the symlink path — so the CLI silently did nothing (0.1.2/0.1.3). It now
  resolves both sides through `realpathSync`, which is symlink-proof. The CI smoke test now invokes
  the CLI through a symlink so this can't regress. (`npx cronvello …` works again.)

## 0.1.3

- **Require Node 20+** (`engines.node >= 20`). The SDK uses the global WebCrypto `crypto`
  (HMAC-signed async callbacks and `generateDispatchSecret`), which is only a default global on
  Node 20+. 0.1.2 declared `>= 18` but would throw `crypto is not defined` on Node 18 (now EOL).
  The new cross-version CI matrix caught this. No API changes.

## 0.1.2

A big developer-experience release — everything is additive and backward-compatible.

### Added

- **Readable schedule builders**: `every`, `everyMinutes`, `everyHours`, `hourly`, `daily`,
  `weekly`, `monthly`, `weekdays`, `weekends`, and `cron` — each returns a validated cron string.
- **Client-side validation** of cron expressions and IANA timezones at define time
  (`validateCron`, `isValidTimeZone`); a typo now throws a clear, job-scoped error instead of
  failing silently server-side. Opt out per app with `validateSchedules: false`.
- **`cronvello.trigger(key, payload?)`** — run a job's handler in-process (no HTTP, no deploy).
  Ideal for unit tests and local development. `ctx.source` is `"local"` for these runs.
- **`defineCronvello.fromEnv(config)`** — read `CRONVELLO_API_KEY`, `CRONVELLO_DISPATCH_SECRET`,
  and `CRONVELLO_APP_URL` (or `PUBLIC_URL`) from the environment so you don't repeat them.
- **Lifecycle hooks** (`onJobStart`, `onJobSuccess`, `onJobError`) for logging, metrics, and error
  reporting. A throwing hook is logged and never breaks the run.
- **`ctx.logger`** (your configured logger, or a no-op) and **`ctx.source`** on the handler context.
- **`formatSyncResult(result, { color?, dryRun? })`** — a clean, human-readable reconcile summary.
- **CLI** — `npx cronvello` with `whoami`, `list`, `tasks`, `runs`, `run`, `status`, `sync`,
  `dev`, and `secret`. Polished, colour-aware output; `--json` for scripting.
- **Dispatch body-size guard** (`maxBodyBytes`, default 1 MiB) — oversized inbound bodies are
  rejected with `413` before parsing.

### Internal

- Comprehensive test suite (unit + contract + opt-in live e2e) and a CI gate
  (typecheck + tests + build across Node 18/20/22) wired ahead of publish.

## 0.1.1

- **Fix**: unwrap the server's `{ success, message, data }` response envelope centrally in the
  transport, so `sync()` and the typed client methods see the inner payload (the 0.1.0 release
  returned the wrapper).

## 0.1.0

- Initial release: code-first registry (`defineCronvello` → `sync()` + Express/Next adapters) and
  a typed low-level `/v1` client. Zero runtime dependencies, dual ESM + CJS.
