import { describe, expect, it, vi } from "vitest";
import { defineCronvello } from "../../src/registry/define.js";
import { formatSyncResult } from "../../src/registry/format.js";
import { CronvelloConfigError } from "../../src/internal/errors.js";
import type { CronvelloAppConfig, CronvelloHooks, ReconcileResult } from "../../src/registry/types.js";
import { enveloped, mockFetch } from "../helpers/mock-fetch.js";

function baseConfig(over: Partial<CronvelloAppConfig> = {}): CronvelloAppConfig {
  const mf = mockFetch(() => ({ body: enveloped({}) }));
  return {
    appName: "Test App",
    appUrl: "https://app.example.com",
    apiKey: "crn_live_test",
    dispatchSecret: "x".repeat(32),
    fetch: mf.fetch,
    jobs: { digest: { schedule: "0 8 * * *", handler: async () => ({ sent: 1 }) } },
    ...over,
  };
}

describe("trigger() — local in-process run", () => {
  it("runs the handler and returns its result", async () => {
    let ran = false;
    const app = defineCronvello(baseConfig({ jobs: { digest: { schedule: "0 8 * * *", handler: async () => { ran = true; return { ok: 42 }; } } } }));
    const result = await app.trigger("digest");
    expect(ran).toBe(true);
    expect(result).toEqual({ ok: 42 });
  });

  it("exposes source='local' and a logger on the context, and merges payload", async () => {
    let ctx: { source?: string; logger?: unknown; body?: Record<string, unknown> } = {};
    const app = defineCronvello(baseConfig({ jobs: { digest: { schedule: "0 8 * * *", handler: async (c) => { ctx = c; } } } }));
    await app.trigger("digest", { manual: true });
    expect(ctx.source).toBe("local");
    expect(ctx.logger).toBeDefined();
    expect(ctx.body!["manual"]).toBe(true);
    expect(ctx.body!["job"]).toBe("digest");
  });

  it("throws for an unknown job key", async () => {
    const app = defineCronvello(baseConfig());
    await expect(app.trigger("ghost")).rejects.toThrow(/Unknown job/);
  });

  it("propagates a handler error", async () => {
    const app = defineCronvello(baseConfig({ jobs: { digest: { schedule: "0 8 * * *", handler: async () => { throw new Error("boom"); } } } }));
    await expect(app.trigger("digest")).rejects.toThrow("boom");
  });
});

describe("lifecycle hooks", () => {
  function spyHooks() {
    const events: string[] = [];
    const hooks: CronvelloHooks = {
      onJobStart: (i) => { events.push(`start:${i.key}:${i.source}`); },
      onJobSuccess: (i) => { events.push(`success:${i.key}:${typeof i.durationMs}`); },
      onJobError: (i) => { events.push(`error:${i.key}:${i.error.message}`); },
    };
    return { events, hooks };
  }

  it("fires start + success around a local trigger", async () => {
    const { events, hooks } = spyHooks();
    const app = defineCronvello(baseConfig({ hooks }));
    await app.trigger("digest");
    expect(events).toEqual(["start:digest:local", "success:digest:number"]);
  });

  it("fires start + error when the handler throws (and the run still rejects)", async () => {
    const { events, hooks } = spyHooks();
    const app = defineCronvello(baseConfig({ hooks, jobs: { digest: { schedule: "0 8 * * *", handler: async () => { throw new Error("nope"); } } } }));
    await expect(app.trigger("digest")).rejects.toThrow("nope");
    expect(events).toEqual(["start:digest:local", "error:digest:nope"]);
  });

  it("fires source='dispatch' on the HTTP sync path", async () => {
    const { events, hooks } = spyHooks();
    const app = defineCronvello(baseConfig({ hooks }));
    await app.handle({ method: "POST", authorization: `Bearer ${"x".repeat(32)}`, headers: {}, rawBody: JSON.stringify({ job: "digest" }) });
    expect(events[0]).toBe("start:digest:dispatch");
  });

  it("a throwing hook never breaks the run", async () => {
    const hooks: CronvelloHooks = { onJobStart: () => { throw new Error("hook exploded"); } };
    const warn = vi.fn();
    const app = defineCronvello(baseConfig({ hooks, logger: { warn } }));
    const result = await app.trigger("digest");
    expect(result).toEqual({ sent: 1 }); // job still completed
    expect(warn).toHaveBeenCalled(); // and the hook failure was logged
  });
});

describe("dispatch — body-size guard", () => {
  it("rejects an oversized body with 413 before parsing", async () => {
    const app = defineCronvello(baseConfig({ maxBodyBytes: 32 }));
    const big = JSON.stringify({ job: "digest", blob: "z".repeat(1000) });
    const res = await app.handle({ method: "POST", authorization: `Bearer ${"x".repeat(32)}`, headers: {}, rawBody: big });
    expect(res.status).toBe(413);
  });
});

describe("defineCronvello.fromEnv", () => {
  const env = {
    CRONVELLO_API_KEY: "crn_live_env",
    CRONVELLO_DISPATCH_SECRET: "y".repeat(32),
    CRONVELLO_APP_URL: "https://from-env.example.com",
  };

  it("reads creds from the environment", () => {
    const app = defineCronvello.fromEnv({ appName: "Env App", jobs: { digest: { schedule: "0 8 * * *", handler: async () => undefined } } }, env);
    expect(app.appName).toBe("Env App");
    expect(app.dispatchUrl).toBe("https://from-env.example.com/cronvello/dispatch");
  });

  it("falls back to PUBLIC_URL for the app URL", () => {
    const app = defineCronvello.fromEnv(
      { appName: "Env App", jobs: { digest: { schedule: "0 8 * * *", handler: async () => undefined } } },
      { ...env, CRONVELLO_APP_URL: undefined, PUBLIC_URL: "https://public.example.com" },
    );
    expect(app.dispatchUrl).toBe("https://public.example.com/cronvello/dispatch");
  });

  it("lets explicit config override the environment", () => {
    const app = defineCronvello.fromEnv({ appName: "Env App", appUrl: "https://explicit.example.com", jobs: { digest: { schedule: "0 8 * * *", handler: async () => undefined } } }, env);
    expect(app.dispatchUrl).toBe("https://explicit.example.com/cronvello/dispatch");
  });

  it("throws listing every missing variable", () => {
    expect(() => defineCronvello.fromEnv({ appName: "x", jobs: { d: { schedule: "0 8 * * *", handler: async () => undefined } } }, {}))
      .toThrow(/CRONVELLO_API_KEY.*CRONVELLO_DISPATCH_SECRET.*CRONVELLO_APP_URL/s);
    expect(() => defineCronvello.fromEnv({ appName: "x", jobs: { d: { schedule: "0 8 * * *", handler: async () => undefined } } }, {}))
      .toThrow(CronvelloConfigError);
  });
});

describe("schedule validation at define time", () => {
  it("rejects an invalid cron with a job-scoped message", () => {
    expect(() => defineCronvello(baseConfig({ jobs: { bad: { schedule: "0 99 * * *", handler: async () => undefined } } })))
      .toThrow(/Job 'bad' has an invalid schedule/);
  });
  it("rejects an invalid timezone", () => {
    expect(() => defineCronvello(baseConfig({ timeZone: "Mars/Phobos" }))).toThrow(/Invalid `timeZone`/);
  });
  it("can be disabled via validateSchedules:false", () => {
    // An unusual-but-accepted-by-server expression should pass when validation is off.
    expect(() => defineCronvello(baseConfig({ validateSchedules: false, jobs: { x: { schedule: "weird sched", handler: async () => undefined } } }))).not.toThrow();
  });
});

describe("formatSyncResult", () => {
  const result: ReconcileResult = {
    jobId: "job_1", jobName: "Test App", jobCreated: true,
    created: 1, updated: 1, unchanged: 1, deleted: 0, skipped: 0,
    changes: [
      { key: "a", action: "created", taskId: "t1" },
      { key: "b", action: "updated", taskId: "t2", changedFields: ["schedule", "timeZone"] },
      { key: "c", action: "unchanged", taskId: "t3" },
    ],
  };

  it("renders a readable summary with counts and changed fields", () => {
    const out = formatSyncResult(result);
    expect(out).toContain('"Test App"');
    expect(out).toContain("+ created");
    expect(out).toMatch(/~ updated\s+b \(schedule, timeZone\)/); // detail present
    expect(out).toContain("1 created, 1 updated, 1 unchanged");
    expect(out).toContain("container created");
    expect(out).not.toContain("\x1b["); // no colour by default
  });

  it("emits ANSI codes when color:true and a 'would sync' verb for dryRun", () => {
    const out = formatSyncResult(result, { color: true, dryRun: true });
    expect(out).toContain("\x1b[");
    expect(out).toContain("would sync");
  });

  it("says 'no changes' when nothing happened", () => {
    const empty: ReconcileResult = { jobId: "job_1", jobName: "Test App", jobCreated: false, created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0, changes: [] };
    expect(formatSyncResult(empty)).toContain("no changes");
  });
});
