/**
 * Contract tests: drive the real client against synthetic public API responses (test/fixtures).
 * These are the regression net for wire-shape drift — most importantly the `{success,message,data}`
 * envelope that the 0.1.0 release shipped without unwrapping.
 */
import { describe, expect, it } from "vitest";
import { CronvelloClient } from "../../src/client/client.js";
import { CronvelloApiError } from "../../src/internal/errors.js";
import { mockFetch } from "../helpers/mock-fetch.js";
import * as fx from "../fixtures/server-responses.js";

/** A client whose every response is the given raw body text + status. */
function clientReturning(raw: string, status = 200) {
  const mf = mockFetch([{ status, body: raw }]);
  return new CronvelloClient({ apiKey: "crn_live_test", fetch: mf.fetch });
}

describe("contract — success envelope is unwrapped to inner data", () => {
  it("GET /v1/me returns the inner account object, not the envelope", async () => {
    const me = await clientReturning(fx.ME_RAW).account.me();
    expect(me.accountId).toBe(42);
    expect(me.plan?.planName).toBe("pro");
    expect(me.limits.maxJobs).toBe(100);
    expect(me.summary.openDlqCount).toBe(0);
    // Regression guard: the raw envelope keys must NOT leak through.
    expect((me as Record<string, unknown>)["success"]).toBeUndefined();
    expect((me as Record<string, unknown>)["data"]).toBeUndefined();
  });

  it("GET /v1/usage returns inner usage counters", async () => {
    const usage = await clientReturning(fx.USAGE_RAW).account.usage();
    expect(usage.usage.executionCount).toBe(1842);
    expect(usage.usage.quota).toBe(10000);
  });

  it("GET /v1/jobs returns the inner array directly", async () => {
    const jobs = await clientReturning(fx.JOBS_RAW).jobs.list();
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs[0]!.name).toBe("Billing API Jobs");
    expect(jobs[0]!.taskCount).toBe(6);
  });

  it("GET /v1/jobs/:id/tasks returns real task shape with hasTargetToken + requestBody", async () => {
    const tasks = await clientReturning(fx.TASKS_RAW).jobs.listTasks("job_example_billing_01");
    const t = tasks[0]!;
    expect(t.name).toBe("nightly-invoice-sync");
    expect(t.hasTargetToken).toBe(true);
    expect(JSON.parse(t.requestBody!)).toEqual({ job: "nightly-invoice-sync" });
    expect(t.status).toBe("ACTIVE");
    expect(t.executionMode).toBe("sync");
  });

  it("GET /v1/runs unwraps to { runs, pagination }", async () => {
    const page = await clientReturning(fx.RUNS_RAW).runs.list({ limit: 1 });
    expect(page.runs[0]!.taskName).toBe("API Health Check");
    expect(page.pagination.hasNext).toBe(true);
    expect(page.pagination.total).toBe(128);
  });
});

describe("contract — the TWO distinct error shapes both map correctly", () => {
  it("middleware 401 ({error,message}, no success/code) → CronvelloApiError with message, no code", async () => {
    const err = await clientReturning(fx.ERR_401_RAW, 401).account.me().catch((e) => e);
    expect(err).toBeInstanceOf(CronvelloApiError);
    expect((err as CronvelloApiError).status).toBe(401);
    expect((err as CronvelloApiError).isAuthError).toBe(true);
    expect((err as CronvelloApiError).message).toContain("Authentication required");
    expect((err as CronvelloApiError).code).toBeUndefined();
  });

  it("handler 404 ({success:false,code,data:null}) → CronvelloApiError carrying the code", async () => {
    const err = await clientReturning(fx.ERR_404_RAW, 404).jobs.get("nope").catch((e) => e);
    expect(err).toBeInstanceOf(CronvelloApiError);
    expect((err as CronvelloApiError).status).toBe(404);
    expect((err as CronvelloApiError).isNotFound).toBe(true);
    expect((err as CronvelloApiError).code).toBe("JOB_NOT_FOUND");
    expect((err as CronvelloApiError).message).toContain("Job not found");
  });
});
