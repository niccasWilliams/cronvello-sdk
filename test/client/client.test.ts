import { describe, expect, it } from "vitest";
import { CronvelloClient, CRONVELLO_DEFAULT_BASE_URL } from "../../src/client/client.js";
import { CronvelloConfigError } from "../../src/internal/errors.js";
import { enveloped, mockFetch, type RecordedCall } from "../helpers/mock-fetch.js";

function client(route: (call: RecordedCall) => unknown = () => ({})) {
  const mf = mockFetch((call) => ({ body: enveloped(route(call)) }));
  return { c: new CronvelloClient({ apiKey: "crn_live_test", fetch: mf.fetch }), mf };
}

function pathOf(call: RecordedCall) {
  return `${call.method} ${new URL(call.url).pathname}`;
}

describe("CronvelloClient — construction", () => {
  it("requires an apiKey", () => {
    // @ts-expect-error missing apiKey
    expect(() => new CronvelloClient({})).toThrow(CronvelloConfigError);
  });
  it("defaults to the production base URL and strips trailing slashes", () => {
    const c = new CronvelloClient({ apiKey: "k", baseUrl: `${CRONVELLO_DEFAULT_BASE_URL}/` });
    expect(c.baseUrl).toBe(CRONVELLO_DEFAULT_BASE_URL);
  });
});

describe("CronvelloClient — endpoint routing", () => {
  it("maps every job resource method to the right verb+path", async () => {
    const { c, mf } = client();
    await c.jobs.list();
    await c.jobs.get("j1");
    await c.jobs.create({ name: "App" }, { idempotencyKey: "cv-job-App" });
    await c.jobs.update("j1", { name: "App2" });
    await c.jobs.delete("j1");
    await c.jobs.start("j1");
    await c.jobs.stop("j1");
    await c.jobs.listTasks("j1");
    await c.jobs.createTask("j1", { name: "t", schedule: "* * * * *", targetUrl: "https://x" });
    expect(mf.calls.map(pathOf)).toEqual([
      "GET /v1/jobs",
      "GET /v1/jobs/j1",
      "POST /v1/jobs",
      "PATCH /v1/jobs/j1",
      "DELETE /v1/jobs/j1",
      "POST /v1/jobs/j1/start",
      "POST /v1/jobs/j1/stop",
      "GET /v1/jobs/j1/tasks",
      "POST /v1/jobs/j1/tasks",
    ]);
    expect(mf.calls[2]!.headers["idempotency-key"]).toBe("cv-job-App");
  });

  it("maps task and run resource methods", async () => {
    const { c, mf } = client();
    await c.tasks.list({ page: 2, status: "ACTIVE" });
    await c.tasks.get("t1");
    await c.tasks.update("t1", { schedule: "0 * * * *" });
    await c.tasks.delete("t1");
    await c.tasks.start("t1");
    await c.tasks.stop("t1");
    await c.tasks.runNow("t1");
    await c.tasks.listRuns("t1", { limit: 5 });
    await c.runs.list({ status: "failed" });
    await c.runs.get("r1");
    await c.account.me();
    await c.account.usage();
    expect(mf.calls.map(pathOf)).toEqual([
      "GET /v1/tasks", "GET /v1/tasks/t1", "PATCH /v1/tasks/t1", "DELETE /v1/tasks/t1",
      "POST /v1/tasks/t1/start", "POST /v1/tasks/t1/stop", "POST /v1/tasks/t1/run", "GET /v1/tasks/t1/runs",
      "GET /v1/runs", "GET /v1/runs/r1", "GET /v1/me", "GET /v1/usage",
    ]);
    // Query params are forwarded.
    expect(mf.calls[0]!.url).toContain("page=2");
    expect(mf.calls[0]!.url).toContain("status=ACTIVE");
  });

  it("URL-encodes path segments", async () => {
    const { c, mf } = client();
    await c.jobs.get("weird/id with space");
    expect(new URL(mf.calls[0]!.url).pathname).toBe("/v1/jobs/weird%2Fid%20with%20space");
  });

  it("reconcileRegistry PUTs /v1/registry with an idempotency key", async () => {
    const { c, mf } = client();
    await c.reconcileRegistry({ appName: "App", tasks: [] }, { idempotencyKey: "cv-reg-App" });
    expect(pathOf(mf.calls[0]!)).toBe("PUT /v1/registry");
    expect(mf.calls[0]!.headers["idempotency-key"]).toBe("cv-reg-App");
  });

  it("exposes a generic request escape hatch", async () => {
    const { c, mf } = client((call) => ({ echoed: call.method }));
    const res = await c.request<{ echoed: string }>("GET", "/v1/heartbeats", { query: { page: 1 } });
    expect(res).toEqual({ echoed: "GET" });
    expect(mf.calls[0]!.url).toContain("page=1");
  });
});
