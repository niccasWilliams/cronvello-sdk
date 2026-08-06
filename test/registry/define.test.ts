import { describe, expect, it } from "vitest";
import { defineCronvello } from "../../src/registry/define.js";
import { CronvelloConfigError } from "../../src/internal/errors.js";
import type { CronvelloAppConfig } from "../../src/registry/types.js";
import type { PublicJob } from "../../src/internal/wire.js";
import { enveloped, mockFetch, type MockResponseSpec, type RecordedCall } from "../helpers/mock-fetch.js";

const BASE = {
  appName: "Test App",
  appUrl: "https://app.example.com",
  apiKey: "crn_live_test",
  dispatchSecret: "x".repeat(32),
};

function cfg(over: Partial<CronvelloAppConfig> = {}): CronvelloAppConfig {
  return { ...BASE, jobs: { digest: { schedule: "0 8 * * *", handler: async () => undefined } }, ...over };
}

function appWith(route: (call: RecordedCall) => MockResponseSpec, over: Partial<CronvelloAppConfig> = {}) {
  const mf = mockFetch((call) => route(call));
  const app = defineCronvello(cfg({ fetch: mf.fetch, ...over }));
  return { app, mf };
}

function publicJob(name: string): PublicJob {
  return {
    id: "job_1", name, description: null, status: "ACTIVE", urgency: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: null, taskCount: 1, activeTaskCount: 1, errorTaskCount: 0,
  };
}

describe("defineCronvello — config validation", () => {
  it("requires appName", () => {
    expect(() => defineCronvello(cfg({ appName: "" }))).toThrow(CronvelloConfigError);
  });
  it("rejects an appUrl that is not an absolute http(s) URL", () => {
    expect(() => defineCronvello(cfg({ appUrl: "app.example.com" }))).toThrow(/absolute http/);
  });
  it("rejects a dispatchSecret shorter than 16 chars when one is given", () => {
    expect(() => defineCronvello(cfg({ dispatchSecret: "tooshort" }))).toThrow(/dispatchSecret/);
  });
});

describe("defineCronvello — local-only apps (no account)", () => {
  const localCfg = (): CronvelloAppConfig => ({
    appName: "Local App",
    jobs: { digest: { schedule: "0 8 * * *", handler: async () => "ok" } },
  });

  it("defines an app from jobs alone, with no apiKey, appUrl or dispatchSecret", () => {
    const app = defineCronvello(localCfg());
    expect(app.keys()).toEqual(["digest"]);
    expect(app.isCloudConfigured).toBe(false);
    expect(app.dispatchPath).toBe("/cronvello/dispatch");
  });

  it("runs a handler locally", async () => {
    await expect(defineCronvello(localCfg()).trigger("digest")).resolves.toBe("ok");
  });

  it("starts the local engine", async () => {
    const engine = defineCronvello(localCfg()).dev({ autoStart: false, installSignalHandlers: false });
    expect(engine.jobs().map((j) => j.key)).toEqual(["digest"]);
    await engine.stop();
  });

  it("reports cloud config as complete once all three fields are present", () => {
    expect(defineCronvello(cfg()).isCloudConfigured).toBe(true);
  });

  it("names every missing field when the cloud is actually used", async () => {
    const app = defineCronvello(localCfg());
    await expect(app.sync()).rejects.toThrow(CronvelloConfigError);
    await expect(app.sync()).rejects.toThrow(/apiKey[\s\S]*appUrl[\s\S]*dispatchSecret/);
    expect(() => app.client).toThrow(/apiKey/);
    expect(() => app.dispatchUrl).toThrow(/appUrl/);
  });

  it("refuses to mount a dispatch handler that could never authenticate", () => {
    const app = defineCronvello(localCfg());
    expect(() => app.expressHandler()).toThrow(/dispatchSecret/);
    expect(() => app.nextHandler()).toThrow(/dispatchSecret/);
  });

  it("rejects an inbound dispatch instead of running it unauthenticated", async () => {
    const res = await defineCronvello(localCfg()).handle({
      method: "POST",
      authorization: "Bearer anything",
      rawBody: JSON.stringify({ job: "digest" }),
      headers: {},
    });
    expect(res.status).toBe(500);
    expect(res.body["ok"]).toBe(false);
  });
});

describe("defineCronvello — job normalization", () => {
  it("accepts the keyed-object form", () => {
    const app = defineCronvello(cfg());
    expect(app.keys()).toEqual(["digest"]);
  });

  it("accepts the array form with explicit keys", () => {
    const app = defineCronvello(cfg({ jobs: [
      { key: "a", schedule: "* * * * *", handler: async () => undefined },
      { key: "b", schedule: "* * * * *", handler: async () => undefined },
    ] }));
    expect(app.keys()).toEqual(["a", "b"]);
  });

  it("rejects an empty job set", () => {
    expect(() => defineCronvello(cfg({ jobs: {} }))).toThrow(/At least one job/);
  });
  it("rejects a duplicate key (array form)", () => {
    expect(() => defineCronvello(cfg({ jobs: [
      { key: "a", schedule: "* * * * *", handler: async () => undefined },
      { key: "a", schedule: "* * * * *", handler: async () => undefined },
    ] }))).toThrow(/Duplicate/);
  });
  it("rejects a missing handler", () => {
    // @ts-expect-error intentionally omit handler
    expect(() => defineCronvello(cfg({ jobs: { x: { schedule: "* * * * *" } } }))).toThrow(/handler/);
  });
  it("rejects a missing schedule", () => {
    // @ts-expect-error intentionally omit schedule
    expect(() => defineCronvello(cfg({ jobs: { x: { handler: async () => undefined } } }))).toThrow(/schedule/);
  });
  it("rejects an over-long key", () => {
    expect(() => defineCronvello(cfg({ jobs: { ["k".repeat(256)]: { schedule: "* * * * *", handler: async () => undefined } } }))).toThrow(/255/);
  });
});

describe("defineCronvello — path & url", () => {
  it("defaults the dispatch path and derives the absolute URL", () => {
    const app = defineCronvello(cfg());
    expect(app.dispatchPath).toBe("/cronvello/dispatch");
    expect(app.dispatchUrl).toBe("https://app.example.com/cronvello/dispatch");
  });
  it("normalizes a custom path and trims trailing slashes on the appUrl", () => {
    const app = defineCronvello(cfg({ appUrl: "https://app.example.com/", dispatchPath: "hooks/cron/" }));
    expect(app.dispatchPath).toBe("/hooks/cron");
    expect(app.dispatchUrl).toBe("https://app.example.com/hooks/cron");
  });
});

describe("defineCronvello — sync (server-side reconcile)", () => {
  it("prefers PUT /v1/registry and maps the response", async () => {
    const { app, mf } = appWith((call) => {
      if (call.method === "PUT" && call.url.endsWith("/v1/registry")) {
        return { body: enveloped({
          job: publicJob("Test App"), jobCreated: true,
          created: 1, updated: 0, unchanged: 0, deleted: 0, skipped: 0,
          changes: [{ key: "digest", action: "created", taskId: "task_1" }],
          tasks: [],
        }) };
      }
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const res = await app.sync();
    expect(res.jobCreated).toBe(true);
    expect(res.created).toBe(1);
    expect(res.jobId).toBe("job_1");
    // Exactly one round-trip — the fast path.
    expect(mf.calls.length).toBe(1);
    const body = mf.calls[0]!.json as { appName: string; tasks: Array<{ key: string }> };
    expect(body.appName).toBe("Test App");
    expect(body.tasks[0]!.key).toBe("digest");
  });

  it("falls back to the client-side differ on a 404 from /v1/registry", async () => {
    const { app, mf } = appWith((call) => {
      const { method, url } = call;
      if (method === "PUT" && url.endsWith("/v1/registry")) return { status: 404, body: { success: false, message: "not found" } };
      if (method === "GET" && url.endsWith("/v1/jobs")) return { body: enveloped([]) }; // no container yet
      if (method === "POST" && url.endsWith("/v1/jobs")) return { body: enveloped(publicJob("Test App")) };
      if (method === "POST" && /\/v1\/jobs\/job_1\/tasks$/.test(url)) {
        return { body: enveloped({ id: "task_1", name: "digest", status: "DISABLED", jobId: "job_1" }) };
      }
      if (method === "POST" && /\/v1\/tasks\/task_1\/start$/.test(url)) return { body: enveloped({ id: "task_1", status: "ACTIVE" }) };
      throw new Error(`unexpected ${method} ${url}`);
    });
    const res = await app.sync();
    expect(res.created).toBe(1);
    expect(res.jobCreated).toBe(true);
    // PUT (404) → GET jobs → POST jobs → POST tasks → POST start
    expect(mf.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "PUT /v1/registry",
      "GET /v1/jobs",
      "POST /v1/jobs",
      "POST /v1/jobs/job_1/tasks",
      "POST /v1/tasks/task_1/start",
    ]);
  });

  it("always uses the client-side path for a dryRun", async () => {
    const { app, mf } = appWith((call) => {
      if (call.method === "GET" && call.url.endsWith("/v1/jobs")) return { body: enveloped([]) };
      throw new Error(`unexpected ${call.method} ${call.url}`);
    });
    const res = await app.sync({ dryRun: true });
    expect(res.jobCreated).toBe(true);
    expect(mf.calls.every((c) => c.method === "GET")).toBe(true); // no PUT /v1/registry, no mutations
  });
});

describe("defineCronvello — run", () => {
  it("throws for an unknown key before any network call", async () => {
    const { app, mf } = appWith(() => ({ body: enveloped({}) }));
    await expect(app.run("ghost")).rejects.toThrow(/Unknown job/);
    expect(mf.calls.length).toBe(0);
  });

  it("resolves the container + task and triggers runNow", async () => {
    const { app } = appWith((call) => {
      const { method, url } = call;
      if (method === "GET" && url.endsWith("/v1/jobs")) return { body: enveloped([publicJob("Test App")]) };
      if (method === "GET" && /\/v1\/jobs\/job_1\/tasks$/.test(url)) return { body: enveloped([{ id: "task_9", name: "digest" }]) };
      if (method === "POST" && /\/v1\/tasks\/task_9\/run$/.test(url)) return { body: enveloped({ success: true, runId: "run_1" }) };
      throw new Error(`unexpected ${method} ${url}`);
    });
    const res = await app.run("digest");
    expect(res).toMatchObject({ success: true, runId: "run_1" });
  });
});
