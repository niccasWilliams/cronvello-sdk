/**
 * Targeted coverage for the harder-to-reach branches: registry-side field diffs, run()
 * not-synced guards, body-based retry-after, and async callback delivery failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile, type ReconcileInput } from "../../src/registry/reconcile.js";
import { createDispatcher, type ResolvedJob } from "../../src/registry/dispatch.js";
import { defineCronvello } from "../../src/registry/define.js";
import { Transport } from "../../src/internal/http.js";
import { CronvelloConfigError } from "../../src/internal/errors.js";
import type { CronvelloJobConfig } from "../../src/registry/types.js";
import { fakeClient, type FakeClient, type SeedTask } from "../helpers/fake-client.js";
import { enveloped, errorBody, mockFetch, type RecordedCall } from "../helpers/mock-fetch.js";

const URL = "https://app.example.com/cronvello/dispatch";
const SECRET = "dispatch-secret-0123456789abcdef";
const TZ = "Europe/Berlin";

function input(fc: FakeClient, jobs: Array<{ key: string; config: CronvelloJobConfig }>): ReconcileInput {
  return { client: fc.client, appName: "Test App", dispatchUrl: URL, dispatchSecret: SECRET, defaultTimeZone: TZ, jobs };
}
function job(key: string, config: Partial<CronvelloJobConfig> = {}) {
  return { key, config: { schedule: "0 8 * * *", handler: async () => undefined, ...config } as CronvelloJobConfig };
}
function seed(key: string, over: Partial<SeedTask> = {}): SeedTask {
  return { name: key, schedule: "0 8 * * *", timeZone: TZ, targetUrl: URL, method: "POST", requestBody: JSON.stringify({ job: key }), hasTargetToken: true, status: "ACTIVE", ...over };
}

describe("reconcile — optional-field diffs", () => {
  it("diffs urgency, maxRetries, executionMode, callbackTimeoutMs, allowConcurrentRuns", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [seed("digest", {
      urgency: "low", maxRetries: 1, executionMode: "sync", callbackTimeoutMs: 1000, allowConcurrentRuns: false,
    })] });
    const res = await reconcile(input(fc, [job("digest", {
      urgency: "high", maxRetries: 5, executionMode: "async_callback", callbackTimeoutMs: 5000, allowConcurrentRuns: true,
    })]));
    const fields = res.changes.find((c) => c.key === "digest")!.changedFields!;
    expect(fields).toEqual(expect.arrayContaining(["urgency", "maxRetries", "executionMode", "callbackTimeoutMs", "allowConcurrentRuns"]));
  });

  it("diffs description and successCriteria deeply", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [seed("digest", { description: "old", successCriteria: { statusCodeMin: 200 } })] });
    const res = await reconcile(input(fc, [job("digest", { description: "new", successCriteria: { statusCodeMin: 201 } })]));
    const fields = res.changes.find((c) => c.key === "digest")!.changedFields!;
    expect(fields).toContain("description");
    expect(fields).toContain("successCriteria");
  });

  it("treats an unparseable existing requestBody as a raw-string compare", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [seed("digest", { requestBody: "not-json" })] });
    const res = await reconcile(input(fc, [job("digest")]));
    expect(res.changes.find((c) => c.key === "digest")!.changedFields).toContain("requestBody");
  });

  it("considers a task unchanged when an unset optional field stays absent", async () => {
    // Registry sets no urgency; existing has urgency null → no diff on that field.
    const fc = fakeClient({ jobName: "Test App", tasks: [seed("digest", { urgency: null })] });
    const res = await reconcile(input(fc, [job("digest")]));
    expect(res.unchanged).toBe(1);
  });
});

describe("define — run() guards", () => {
  function appWith(route: (c: RecordedCall) => unknown) {
    const mf = mockFetch((c) => ({ body: enveloped(route(c)) }));
    return defineCronvello({ appName: "Test App", appUrl: "https://app.example.com", apiKey: "crn_live_test", dispatchSecret: SECRET, fetch: mf.fetch, jobs: { digest: { schedule: "* * * * *", handler: async () => undefined } } });
  }

  it("throws when the app container is not synced yet", async () => {
    const app = appWith((c) => (c.url.endsWith("/v1/jobs") ? [] : {}));
    await expect(app.run("digest")).rejects.toThrow(/not synced/);
  });

  it("throws when the job has no task yet", async () => {
    const app = appWith((c) => {
      if (c.url.endsWith("/v1/jobs")) return [{ id: "job_1", name: "Test App" }];
      if (/\/tasks$/.test(c.url)) return []; // container exists, no matching task
      return {};
    });
    await expect(app.run("digest")).rejects.toThrow(/no task yet/);
  });
});

describe("define — sync() rethrows non-fallback API errors", () => {
  it("propagates a 500 from PUT /v1/registry instead of falling back", async () => {
    const mf = mockFetch((c) => (c.method === "PUT" ? { status: 500, body: errorBody("server boom") } : { body: enveloped([]) }));
    const app = defineCronvello({ appName: "Test App", appUrl: "https://app.example.com", apiKey: "k", dispatchSecret: SECRET, fetch: mf.fetch, jobs: { digest: { schedule: "* * * * *", handler: async () => undefined } } });
    await expect(app.sync()).rejects.toThrow(/server boom/);
    // Every call was the PUT (retried by the transport) — no client-side GET /v1/jobs fallback.
    expect(mf.calls.every((c) => c.method === "PUT")).toBe(true);
  });
});

describe("transport — retry-after from the response body", () => {
  it("reads data.retryAfterSeconds when no Retry-After header is present", async () => {
    const mf = mockFetch([{ status: 429, body: { success: false, message: "slow", data: { retryAfterSeconds: 3 } } }]);
    const t = new Transport({ baseUrl: "https://api.cronvello.com", apiKey: "k", fetch: mf.fetch, maxRetries: 0 });
    const err = await t.request({ method: "GET", path: "/x" }).catch((e) => e);
    expect(err.retryAfterSeconds).toBe(3);
  });
});

describe("dispatch — callback delivery failures", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function asyncDispatcher(handler: ResolvedJob["config"]["handler"]) {
    const logs: string[] = [];
    const d = createDispatcher({
      jobs: new Map([["digest", { key: "digest", config: { schedule: "* * * * *", handler } }]]),
      dispatchSecret: SECRET,
      logger: { warn: (m) => logs.push(`warn:${m}`), error: (m) => logs.push(`error:${m}`) },
    });
    return { d, logs };
  }

  it("logs a warning when the callback endpoint returns non-2xx", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }));
    const { d, logs } = asyncDispatcher(async () => "ok");
    let work: Promise<unknown> | undefined;
    await d.handle({ method: "POST", authorization: `Bearer ${SECRET}`, headers: {}, rawBody: JSON.stringify({ job: "digest", _callback: { url: "https://x/cb", runId: "r" } }), waitUntil: (p) => { work = p; } });
    await work;
    expect(logs.some((l) => l.startsWith("warn:") && l.includes("503"))).toBe(true);
  });

  it("logs an error when callback delivery throws", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    const { d, logs } = asyncDispatcher(async () => "ok");
    let work: Promise<unknown> | undefined;
    await d.handle({ method: "POST", authorization: `Bearer ${SECRET}`, headers: {}, rawBody: JSON.stringify({ job: "digest", _callback: { url: "https://x/cb", runId: "r" } }), waitUntil: (p) => { work = p; } });
    await work;
    expect(logs.some((l) => l.startsWith("error:"))).toBe(true);
  });

  it("honours a custom expectedSignatureHeader from the callback envelope", async () => {
    const captured: { headers?: Record<string, string> } = {};
    vi.stubGlobal("fetch", async (_u: string, init: { headers: Record<string, string> }) => { captured.headers = init.headers; return { ok: true, status: 200 }; });
    const { d } = asyncDispatcher(async () => "ok");
    let work: Promise<unknown> | undefined;
    await d.handle({ method: "POST", authorization: `Bearer ${SECRET}`, headers: {}, rawBody: JSON.stringify({ job: "digest", _callback: { url: "https://x/cb", runId: "r", expectedSignatureHeader: "X-Custom-Sig" } }), waitUntil: (p) => { work = p; } });
    await work;
    expect(captured.headers!["X-Custom-Sig"]).toBeDefined();
  });
});

describe("define — config edge", () => {
  it("rejects a non-object config", () => {
    // @ts-expect-error null config
    expect(() => defineCronvello(null)).toThrow(CronvelloConfigError);
  });
});
