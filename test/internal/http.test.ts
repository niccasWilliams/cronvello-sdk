import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transport } from "../../src/internal/http.js";
import {
  CronvelloApiError,
  CronvelloConfigError,
  CronvelloNetworkError,
} from "../../src/internal/errors.js";
import { abortError, enveloped, errorBody, mockFetch, type MockResponseSpec } from "../helpers/mock-fetch.js";

const BASE = "https://api.cronvello.com";

function transport(script: MockResponseSpec[] | Parameters<typeof mockFetch>[0], opts: Partial<ConstructorParameters<typeof Transport>[0]> = {}) {
  const mf = mockFetch(script as MockResponseSpec[]);
  const t = new Transport({ baseUrl: BASE, apiKey: "crn_live_test", fetch: mf.fetch, ...opts });
  return { t, mf };
}

describe("Transport — construction", () => {
  it("rejects a missing apiKey", () => {
    expect(() => new Transport({ baseUrl: BASE, apiKey: "", fetch: mockFetch([]).fetch })).toThrow(CronvelloConfigError);
  });

  it("rejects a missing baseUrl", () => {
    expect(() => new Transport({ baseUrl: "", apiKey: "k", fetch: mockFetch([]).fetch })).toThrow(CronvelloConfigError);
  });

  it("rejects when no fetch is available and none is global", () => {
    const saved = (globalThis as { fetch?: unknown }).fetch;
    try {
      // @ts-expect-error force-remove the global to exercise the guard
      delete globalThis.fetch;
      expect(() => new Transport({ baseUrl: BASE, apiKey: "k" })).toThrow(/No global fetch/);
    } finally {
      (globalThis as { fetch?: unknown }).fetch = saved;
    }
  });

  it("strips trailing slashes from the base URL", async () => {
    const { t, mf } = transport([{ body: enveloped({ ok: 1 }) }], { baseUrl: `${BASE}///` });
    await t.request({ method: "GET", path: "/v1/me" });
    expect(mf.lastCall().url).toBe(`${BASE}/v1/me`);
  });
});

describe("Transport — request shaping", () => {
  it("sends bearer auth, accept, and merges default headers", async () => {
    const { t, mf } = transport([{ body: enveloped({}) }], { defaultHeaders: { "user-agent": "cronvello-sdk" } });
    await t.request({ method: "GET", path: "/v1/me" });
    const { headers } = mf.lastCall();
    expect(headers["authorization"]).toBe("Bearer crn_live_test");
    expect(headers["accept"]).toBe("application/json");
    expect(headers["user-agent"]).toBe("cronvello-sdk");
    expect(headers["content-type"]).toBeUndefined(); // no body → no content-type
  });

  it("serializes a JSON body and sets content-type", async () => {
    const { t, mf } = transport([{ body: enveloped({}) }]);
    await t.request({ method: "POST", path: "/v1/jobs", body: { name: "x" } });
    const call = mf.lastCall();
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.json).toEqual({ name: "x" });
  });

  it("attaches an idempotency-key header when provided", async () => {
    const { t, mf } = transport([{ body: enveloped({}) }]);
    await t.request({ method: "POST", path: "/v1/jobs", body: {}, idempotencyKey: "cv-job-foo" });
    expect(mf.lastCall().headers["idempotency-key"]).toBe("cv-job-foo");
  });

  it("builds a query string, skipping undefined values and encoding the rest", async () => {
    const { t, mf } = transport([{ body: enveloped({}) }]);
    await t.request({ method: "GET", path: "/v1/runs", query: { page: 2, status: "failed", jobId: undefined, q: "a b&c" } });
    const url = mf.lastCall().url;
    expect(url).toContain("page=2");
    expect(url).toContain("status=failed");
    expect(url).not.toContain("jobId");
    expect(url).toContain("q=a%20b%26c");
  });

  it("normalizes a path that does not start with a slash", async () => {
    const { t, mf } = transport([{ body: enveloped({}) }]);
    await t.request({ method: "GET", path: "v1/me" });
    expect(mf.lastCall().url).toBe(`${BASE}/v1/me`);
  });
});

describe("Transport — envelope unwrapping", () => {
  it("unwraps a { success, message, data } envelope", async () => {
    const { t } = transport([{ body: enveloped({ id: "job_1", name: "App" }) }]);
    const res = await t.request<{ id: string; name: string }>({ method: "GET", path: "/v1/jobs/x" });
    expect(res).toEqual({ id: "job_1", name: "App" });
  });

  it("passes non-enveloped bodies through unchanged", async () => {
    const { t } = transport([{ body: { id: "raw" } }]);
    const res = await t.request({ method: "GET", path: "/x" });
    expect(res).toEqual({ id: "raw" });
  });

  it("returns null for an empty body (e.g. 204/DELETE)", async () => {
    const { t } = transport([{ status: 204, body: "" }]);
    const res = await t.request({ method: "DELETE", path: "/v1/jobs/x" });
    expect(res).toBeNull();
  });

  it("unwraps data:null without treating it as non-enveloped", async () => {
    const { t } = transport([{ body: { success: true, message: "deleted", data: null } }]);
    const res = await t.request({ method: "DELETE", path: "/v1/jobs/x" });
    expect(res).toBeNull();
  });
});

describe("Transport — error mapping", () => {
  it("throws a CronvelloApiError carrying status, code, endpoint and message", async () => {
    const { t } = transport([{ status: 422, body: errorBody("Invalid schedule", { code: "VALIDATION" }) }]);
    await expect(t.request({ method: "POST", path: "/v1/jobs/x/tasks" })).rejects.toMatchObject({
      name: "CronvelloApiError",
      status: 422,
      code: "VALIDATION",
      endpoint: "POST /v1/jobs/x/tasks",
    });
    await expect(t.request({ method: "POST", path: "/v1/jobs/x/tasks" })).rejects.toThrow(/Invalid schedule/);
  });

  it("does not retry a non-retryable 4xx", async () => {
    const { t, mf } = transport([{ status: 400, body: errorBody("bad") }]);
    await expect(t.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(CronvelloApiError);
    expect(mf.calls.length).toBe(1);
  });

  it("exposes the rate-limit helpers on 429", async () => {
    const { t } = transport([{ status: 429, body: errorBody("slow down"), headers: { "retry-after": "7" } }], { maxRetries: 0 });
    const err = await t.request({ method: "GET", path: "/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(CronvelloApiError);
    expect((err as CronvelloApiError).isRateLimited).toBe(true);
    expect((err as CronvelloApiError).retryAfterSeconds).toBe(7);
  });
});

describe("Transport — retries & backoff", () => {
  beforeEach(() => {
    // Full-jitter backoff multiplies by Math.random — pin it to 0 so retries sleep 0ms.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => vi.restoreAllMocks());

  it("retries retryable 5xx then resolves", async () => {
    const { t, mf } = transport([
      { status: 503, body: errorBody("unavailable") },
      { status: 502, body: errorBody("bad gateway") },
      { body: enveloped({ ok: true }) },
    ]);
    const res = await t.request({ method: "GET", path: "/x" });
    expect(res).toEqual({ ok: true });
    expect(mf.calls.length).toBe(3);
  });

  it("gives up after maxRetries and throws the last API error", async () => {
    const { t, mf } = transport([{ status: 500, body: errorBody("boom") }], { maxRetries: 2 });
    await expect(t.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(CronvelloApiError);
    expect(mf.calls.length).toBe(3); // initial + 2 retries
  });

  it("retries a network error then resolves", async () => {
    let n = 0;
    const { t } = transport(() => (n++ === 0 ? { throw: new Error("ECONNRESET") } : { body: enveloped({ ok: 1 }) }));
    const res = await t.request({ method: "GET", path: "/x" });
    expect(res).toEqual({ ok: 1 });
  });

  it("wraps a persistent network failure in CronvelloNetworkError", async () => {
    const { t, mf } = transport([{ throw: new Error("DNS fail") }], { maxRetries: 1 });
    await expect(t.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(CronvelloNetworkError);
    expect(mf.calls.length).toBe(2);
  });
});

describe("Transport — timeout & abort", () => {
  it("aborts a hung request after timeoutMs and surfaces a network error", async () => {
    const hangFetch = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError()));
      });
    const t = new Transport({ baseUrl: BASE, apiKey: "k", fetch: hangFetch as never, timeoutMs: 10, maxRetries: 0 });
    await expect(t.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(CronvelloNetworkError);
  });

  it("honours an externally-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { t } = transport([{ body: enveloped({}) }], { maxRetries: 0 });
    await expect(t.request({ method: "GET", path: "/x", signal: controller.signal })).rejects.toBeInstanceOf(
      CronvelloNetworkError,
    );
  });
});

describe("Transport — telemetry", () => {
  it("invokes onRequest once per attempt with timing metadata", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const seen: Array<{ status: number; attempt: number }> = [];
    const { t } = transport(
      [{ status: 500, body: errorBody("x") }, { body: enveloped({}) }],
      { onRequest: (i) => seen.push({ status: i.status, attempt: i.attempt }) },
    );
    await t.request({ method: "GET", path: "/x" });
    expect(seen).toEqual([
      { status: 500, attempt: 0 },
      { status: 200, attempt: 1 },
    ]);
    vi.restoreAllMocks();
  });
});
