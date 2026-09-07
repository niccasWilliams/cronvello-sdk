/**
 * @cronvello/sdk — code-first cron jobs for Cronvello.
 *
 * Two layers, one package:
 *   • High-level registry: `defineCronvello({ jobs })` → `.sync()` + `.expressHandler()` / `.nextHandler()`.
 *     Define jobs in code; the SDK reconciles them to https://api.cronvello.com and runs them.
 *   • Low-level client: `new CronvelloClient({ apiKey })` → typed access to the whole `/v1` API.
 *
 * Plus an operator surface, `new CronvelloAdminClient({ serviceKey })`, for the service that
 * registers apps into Cronvello. Separate class, separate credential — see its doc comment.
 */

// ── High-level registry ────────────────────────────────────────────────────
export { defineCronvello, type CronvelloApp, type CronvelloEnvConfig } from "./registry/define.js";
export { formatSyncResult, type FormatOptions } from "./registry/format.js";
export type {
  CronvelloAppConfig,
  CronvelloJobConfig,
  CronvelloJobConfigWithKey,
  CronvelloJobsInput,
  CronvelloJobContext,
  CronvelloJobHandler,
  CronvelloLogger,
  CronvelloHooks,
  CronvelloRunSource,
  ReconcileResult,
  ReconcileTaskChange,
  SyncOptions,
} from "./registry/types.js";
export type { DispatchRequest, DispatchResponse } from "./registry/dispatch.js";

// ── Schedule builders ──────────────────────────────────────────────────────
export {
  cron,
  every,
  everyMinutes,
  everyHours,
  hourly,
  daily,
  weekly,
  monthly,
  weekdays,
  weekends,
  schedule,
  type Weekday,
} from "./schedule/index.js";
export { validateCron, isValidTimeZone, type CronValidation } from "./internal/cron.js";

// ── Schedule preview (pure, no account) ─────────────────────────────────────
// The local engine itself lives under the `@cronvello/sdk/dev` subpath; these two pure helpers are
// surfaced here too because reasoning about *when* a schedule fires is useful everywhere.
export {
  nextOccurrence,
  previewSchedule,
  type NextOccurrenceOptions,
  type PreviewOptions,
} from "./internal/cron-schedule.js";

// ── Low-level client ───────────────────────────────────────────────────────
export {
  CronvelloClient,
  CRONVELLO_DEFAULT_BASE_URL,
  type CronvelloClientOptions,
} from "./client/client.js";

// ── Operator client (backend-to-backend) ────────────────────────────
// Not needed to *use* Cronvello — this is for the service that provisions apps into it.
// It takes Cronvello's service key, deliberately a different option than the account `apiKey`.
export {
  CronvelloAdminClient,
  type CronvelloAdminClientOptions,
} from "./client/admin-client.js";

// ── Faehigkeitsbericht ──────────────────────────────────────────────
// Was dieser Dienst einem Verwalter anbietet, aus der Methodenliste des Clients gelesen.
export {
  cronvelloCapabilities,
  type CronvelloCapabilities,
  type CronvelloCapability,
} from "./capabilities.js";
export type {
  ExternalApp,
  ExternalAppAnchorReconcileResult,
  ExternalAppApiKey,
  ExternalAppApiKeyList,
  ExternalAppAuthMethod,
  ExternalAppBindApiKeyInput,
  ExternalAppBoundApiKey,
  ExternalAppIssueApiKeyInput,
  ExternalAppIssuedApiKey,
  ExternalAppRegisterInput,
  ExternalAppRegisterResult,
  ExternalAppRegistration,
  ExternalAppRegistrationList,
  ExternalAppRevokeKeyInput,
  ExternalAppRevokeKeyResult,
  ExternalAppRollbackKeyResult,
  ExternalAppRotateKeyInput,
  ExternalAppRotateKeyResult,
  ExternalAppStatus,
  CatalogRetiredReason,
} from "./internal/admin-wire.js";

// ── Errors ─────────────────────────────────────────────────────────────────
export {
  CronvelloError,
  CronvelloApiError,
  CronvelloNetworkError,
  CronvelloConfigError,
} from "./internal/errors.js";

// ── Wire types ─────────────────────────────────────────────────────────────
export type {
  Urgency,
  ExecutionMode,
  HttpMethod,
  JobStatus,
  RunStatus,
  RunType,
  CallbackStatus,
  SuccessCriteria,
  PublicJob,
  PublicTask,
  PublicRun,
  JobCreateBody,
  JobUpdateBody,
  TaskCreateBody,
  TaskUpdateBody,
  RunsPage,
  TasksPage,
  RunNowResult,
  RegistryTaskInput,
  RegistryReconcileRequest,
  RegistryReconcileResponse,
  RegistryReconcileChange,
  MeResponse,
  UsageResponse,
  Pagination,
  RunsQuery,
  AccountTasksQuery,
  AccountRunsQuery,
} from "./internal/wire.js";

/**
 * Generate a strong random dispatch secret (hex). Convenience for setup scripts:
 *   node -e "console.log(require('@cronvello/sdk').generateDispatchSecret())"
 */
export function generateDispatchSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
