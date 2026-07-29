import { afterEach, describe, expect, it, vi } from "vitest";
import { createDispatcher, type DispatchRequest, type ResolvedJob } from "../../src/registry/dispatch.js";
import { signHmacSha256 } from "../../src/registry/verify.js";
import type { CronvelloJobContext } from "../../src/registry/types.js";

const SECRET = "dispatch-secret-0123456789abcdef";

function dispatcher(jobs: Record<string, ResolvedJob["config"]>, logger?: Parameters<typeof createDispatcher>[0]["logger"]) {
  const map = new Map<string, ResolvedJob>(Object.entries(jobs).map(([key, config]) => [key, { key, config }]));
  return createDispatcher({ jobs: map, dispatchSecret: SECRET, logger });
}

function req(over: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    method: "POST",
    authorization: `Bearer ${SECRET}`,
    rawBody: JSON.stringify({ job: "digest" }),
    headers: {},
    ...over,
  };
}

describe("dispatch — method & auth", () => {
  it("rejects non-POST with 405", async () => {
    const d = dispatcher({ digest: { schedule: "* * * * *", handler: async () => "ok" } });
    expect((await d.handle(req({ method: "GET" }))).status).toBe(405);
  });

  it("rejects a missing bearer with 401", async () => {
    const d = dispatcher({ digest: { schedule: "* * * * *", handler: async () => "ok" } });
    expect((await d.handle(req({ authorization: undefined }))).status).toBe(401);
  });

  it("rejects a wrong bearer with 401", async () => {
    const d = dispatcher({ digest: { schedule: "* * * * *", handler: async () => "ok" } });
    expect((await d.handle(req({ authorization: "Bearer not-the-secret-xxxxxxxxxxxx" }))).status).toBe(401);
  });
});

describe("dispatch — body validation", () => {
  const d = dispatcher({ digest: { schedule: "* * * * *", handler: async () => "ok" } });

  it("400s on invalid JSON", async () => {
    expect((await d.handle(req({ rawBody: "{not json" }))).status).toBe(400);
  });

  it("400s when the body is not a JSON object", async () => {
    expect((await d.handle(req({ rawBody: "[1,2,3]" }))).status).toBe(400);
    expect((await d.handle(req({ rawBody: "42" }))).status).toBe(400);
  });

  it("400s when the job key is missing", async () => {
    expect((await d.handle(req({ rawBody: "{}" }))).status).toBe(400);
  });

  it("404s for an unknown job", async () => {
    const res = await d.handle(req({ rawBody: JSON.stringify({ job: "ghost" }) }));
    expect(res.status).toBe(404);
    expect(res.body["error"]).toContain("ghost");
  });
});

describe("dispatch — sync execution", () => {
  it("runs the handler and returns its result on 200", async () => {
    const d = dispatcher({ digest: { schedule: "0 8 * * *", handler: async () => ({ sent: 3 }) } });
    const res = await d.handle(req({ rawBody: JSON.stringify({ job: "digest", schedule: "0 8 * * *" }) }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, job: "digest", result: { sent: 3 } });
  });

  it("passes a fully-populated context to the handler", async () => {
    let seen: CronvelloJobContext | undefined;
    const d = dispatcher({ digest: { schedule: "0 8 * * *", payload: { tenant: "acme" }, handler: async (ctx) => { seen = ctx; } } });
    await d.handle(req({
      rawBody: JSON.stringify({ job: "digest", schedule: "0 8 * * *", extra: 1 }),
      headers: { "x-trace": "abc" },
    }));
    expect(seen).toMatchObject({
      key: "digest",
      schedule: "0 8 * * *",
      payload: { tenant: "acme" },
      isAsync: false,
      headers: { "x-trace": "abc" },
    });
    expect(seen!.body["extra"]).toBe(1);
  });

  it("maps a thrown handler to a 500 with the error message", async () => {
    const d = dispatcher({ digest: { schedule: "* * * * *", handler: async () => { throw new Error("kaboom"); } } });
    const res = await d.handle(req());
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, job: "digest", error: "kaboom" });
  });

  it("returns result:null when the handler returns undefined", async () => {
    const d = dispatcher({ digest: { schedule: "* * * * *", handler: async () => undefined } });
    expect((await d.handle(req())).body["result"]).toBeNull();
  });
});

describe("dispatch — async_callback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("acknowledges with 202, runs in the background, and posts a signed callback", async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: string }) => {
      captured.url = url;
      captured.headers = init.headers;
      captured.body = init.body;
      return { ok: true, status: 200 };
    });

    const d = dispatcher({ digest: { schedule: "* * * * *", handler: async () => ({ done: true }) } });
    let work: Promise<unknown> | undefined;
    const res = await d.handle(req({
      rawBody: JSON.stringify({ job: "digest", _callback: { url: "https://api.cronvello.com/cb", runId: "run_1" } }),
      waitUntil: (p) => { work = p; },
    }));

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, accepted: true });
    await work; // drain the background task

    expect(captured.url).toBe("https://api.cronvello.com/cb");
    const payload = JSON.parse(captured.body!);
    expect(payload).toMatchObject({ runId: "run_1", success: true, result: { done: true } });
    // Signature must match HMAC-SHA256 of the exact body with the dispatch secret.
    const expected = await signHmacSha256(captured.body!, SECRET);
    expect(captured.headers!["X-Webhook-Signature"]).toBe(expected);
  });

  it("reports handler failure in the callback payload", async () => {
    const captured: { body?: string } = {};
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      captured.body = init.body;
      return { ok: true, status: 200 };
    });
    const d = dispatcher({ digest: { schedule: "* * * * *", handler: async () => { throw new Error("bg fail"); } } });
    let work: Promise<unknown> | undefined;
    await d.handle(req({
      rawBody: JSON.stringify({ job: "digest", _callback: { url: "https://x/cb", runId: "run_2" } }),
      waitUntil: (p) => { work = p; },
    }));
    await work;
    expect(JSON.parse(captured.body!)).toMatchObject({ runId: "run_2", success: false, error: "bg fail" });
  });

  it("marks the context isAsync when a callback envelope is present", async () => {
    let isAsync: boolean | undefined;
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200 }));
    const d = dispatcher({ digest: { schedule: "* * * * *", handler: async (ctx) => { isAsync = ctx.isAsync; } } });
    let work: Promise<unknown> | undefined;
    await d.handle(req({
      rawBody: JSON.stringify({ job: "digest", _callback: { url: "https://x/cb", runId: "r" } }),
      waitUntil: (p) => { work = p; },
    }));
    await work;
    expect(isAsync).toBe(true);
  });
});
