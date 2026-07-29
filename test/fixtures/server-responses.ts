/**
 * Synthetic Cronvello `/v1` responses modeled after the public API contract.
 * These are the contract the SDK is written against — freezing the shapes here turns any server
 * drift (e.g. the `{ success, message, data }` envelope that the 0.1.0 release failed to unwrap)
 * into a failing test instead of a production incident.
 *
 * Stored as raw response *text* so the tests exercise the real JSON.parse + unwrap path, not a
 * pre-decoded object. Never refresh these fixtures with raw customer or internal tenant data.
 */

/** GET /v1/me — success envelope wrapping the account identity. */
export const ME_RAW =
  '{"success":true,"message":"OK","data":{"accountId":42,"accountName":"Acme Production","email":"ops@example.com","isActive":true,"createdAt":"2026-01-15T10:00:00.000Z","serverTime":"2026-07-01T12:00:00.000Z","plan":{"planName":"pro","displayName":"Pro"},"limits":{"maxJobs":100,"maxTasksPerJob":50,"minIntervalSeconds":60,"rateLimitPerMinute":600,"rateLimitPerHour":10000},"usage":{"jobsUsed":4,"period":{"start":"2026-07-01T00:00:00.000Z","end":"2026-08-01T00:00:00.000Z"},"executionCount":1842,"executionQuota":10000},"summary":{"openDlqCount":0,"heartbeatNeedsAttention":0,"activeMaintenanceWindows":0}}}';

/** GET /v1/usage — success envelope wrapping usage counters. */
export const USAGE_RAW =
  '{"success":true,"message":"OK","data":{"accountId":42,"serverTime":"2026-07-01T12:00:00.000Z","plan":{"planName":"pro","displayName":"Pro"},"period":{"start":"2026-07-01T00:00:00.000Z","end":"2026-08-01T00:00:00.000Z"},"usage":{"executionCount":1842,"quota":10000,"quotaExceeded":false,"quotaUsedPercent":18.42}}}';

/** GET /v1/jobs — success envelope wrapping an array of job containers. */
export const JOBS_RAW =
  '{"success":true,"message":"OK","data":[{"id":"job_example_billing_01","name":"Billing API Jobs","description":null,"status":"ACTIVE","urgency":"low","createdAt":"2026-01-15T10:05:00.000Z","updatedAt":null,"taskCount":6,"activeTaskCount":6,"errorTaskCount":0},{"id":"job_example_reporting_02","name":"Reporting API Jobs","description":null,"status":"ACTIVE","urgency":"low","createdAt":"2026-01-15T10:10:00.000Z","updatedAt":null,"taskCount":3,"activeTaskCount":2,"errorTaskCount":1}]}';

/** GET /v1/jobs/:id/tasks — success envelope wrapping an array with one real task. */
export const TASKS_RAW =
  '{"success":true,"message":"OK","data":[{"id":"task_example_invoice_sync_01","jobId":"job_example_billing_01","jobName":"Billing API Jobs","name":"nightly-invoice-sync","description":"Synchronize pending invoices","schedule":"0 2 * * *","timeZone":"Europe/Berlin","type":"http_request","status":"ACTIVE","targetUrl":"https://api.example.com/cronvello/dispatch","hasTargetToken":true,"method":"POST","customHeaderNames":[],"requestBody":"{\\"job\\":\\"nightly-invoice-sync\\"}","requestTimeoutMs":null,"successCriteria":null,"urgency":"medium","maxRetries":3,"executionMode":"sync","callbackTimeoutMs":null,"allowConcurrentRuns":false,"nextRun":"2026-07-02T00:00:00.000Z","lastRunAt":null,"lastRunStatus":null,"createdAt":"2026-01-15T10:15:00.000Z","hasOpenDlq":false,"statusReason":"Active — awaiting first run"}]}';

/** GET /v1/runs?limit=1 — success envelope wrapping a paginated runs page. */
export const RUNS_RAW =
  '{"success":true,"message":"OK","data":{"runs":[{"id":"run_example_scheduled_01","jobTaskId":"task_example_health_check_01","taskName":"API Health Check","jobId":"job_example_reporting_02","jobName":"Reporting API Jobs","status":"running","runType":"scheduled","httpStatusCode":null,"responseBody":null,"startedAt":"2026-07-01T11:59:58.000Z","endedAt":null,"durationMs":null,"error":null,"executionMode":"async_callback","callbackStatus":"acknowledged"}],"pagination":{"page":1,"limit":1,"total":128,"totalPages":128,"hasNext":true,"hasPrev":false}}}';

/**
 * GET /v1/me with a bad key — 401. NOTE: this comes from the auth *middleware*, which uses a
 * DIFFERENT shape than the route handlers: `{ error, message }` with NO `success` and NO `code`.
 * The transport must still extract the human message and leave `code` undefined.
 */
export const ERR_401_RAW = '{"error":"unauthorized","message":"Authentication required. Allowed methods: API Key"}';

/**
 * GET /v1/jobs/:bad — 404 from a route handler: the standard error envelope
 * `{ success:false, message, code, data:null }`. Here the transport must surface `code`.
 */
export const ERR_404_RAW = '{"success":false,"message":"Job not found","code":"JOB_NOT_FOUND","data":null}';
