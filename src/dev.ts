/**
 * `@cronvello/sdk/dev` — the **local engine** subpath.
 *
 * Everything you need to run Cronvello jobs locally (no account, no cloud, no network) and to reason
 * about schedules off-line. The high-level entry is `app.dev()` on a `defineCronvello` app (see the
 * main package); these are the lower-level primitives the engine and CLI are built from, exported so
 * you can drive them directly — e.g. compute the next fire of a cron string, or embed the engine in
 * your own dev harness.
 *
 *   import { previewSchedule, nextOccurrence } from "@cronvello/sdk/dev";
 *
 *   nextOccurrence("0 8 * * *", { timeZone: "Europe/Berlin" }); // → Date of the next 08:00 Berlin
 *   previewSchedule("*\/15 * * * *", { count: 4 });             // → next four fire times
 */

export {
  LocalEngine,
  createLocalEngine,
  type EngineJob,
  type EngineEvent,
  type EngineRunner,
  type EngineClock,
  type LocalEngineOptions,
  type RunRecord,
  type RunStatus,
  type JobSnapshot,
} from "./dev/engine.js";

export {
  parseCron,
  nextOccurrence,
  previewSchedule,
  upcomingFires,
  localTimeZone,
  type ParsedCron,
  type NextOccurrenceOptions,
  type PreviewOptions,
  type UpcomingOptions,
  type UpcomingJob,
  type UpcomingFire,
} from "./internal/cron-schedule.js";

export {
  startDashboard,
  type DashboardOptions,
  type DashboardHandle,
} from "./dev/dashboard.js";
