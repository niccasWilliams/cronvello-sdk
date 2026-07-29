# Changelog

All notable changes to `@cronvello/sdk` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: minor-feature additions ship as patch releases).

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
