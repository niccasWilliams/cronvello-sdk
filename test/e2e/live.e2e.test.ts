/**
 * Live end-to-end against the real Cronvello API. OPT-IN: runs only when CRONVELLO_E2E=1 (see
 * vitest.config.ts) AND CRONVELLO_API_KEY is set. It creates an ISOLATED throwaway job container
 * ("SDK E2E <ts>"), reconciles into it, exercises the idempotent + dry-run paths and a local
 * trigger, then deletes the container — it never touches any other app's jobs.
 *
 *   CRONVELLO_E2E=1 CRONVELLO_API_KEY=crn_live_… npm run test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineCronvello, type CronvelloApp } from "../../src/registry/define.js";
import { CronvelloClient } from "../../src/client/client.js";

const apiKey = process.env["CRONVELLO_API_KEY"];
const baseUrl = process.env["CRONVELLO_API_URL"];
const RUN = !!apiKey;

const APP_NAME = `SDK E2E ${Date.now()}`;
const client = new CronvelloClient({ apiKey: apiKey ?? "crn_live_missing", ...(baseUrl ? { baseUrl } : {}) });

let app: CronvelloApp;
let triggered = false;

describe.runIf(RUN)("live e2e — isolated throwaway container", () => {
  beforeAll(() => {
    app = defineCronvello({
      appName: APP_NAME,
      // The server DNS-validates targetUrl, so use a resolvable host. The throwaway task is
      // deleted within seconds and never actually fires; example.com would 404 harmlessly anyway.
      appUrl: "https://example.com",
      apiKey: apiKey!,
      dispatchSecret: "e2e-".padEnd(40, "0"),
      ...(baseUrl ? { baseUrl } : {}),
      jobs: {
        "e2e-ping": { schedule: "0 0 * * *", description: "SDK e2e probe", handler: async () => { triggered = true; return { pong: true }; } },
      },
    });
  });

  afterAll(async () => {
    // Best-effort cleanup: delete the throwaway container so nothing lingers on the account.
    try {
      const container = (await client.jobs.list()).find((j) => j.name === APP_NAME);
      if (container) await client.jobs.delete(container.id);
    } catch {
      // ignore — leaves an obviously-named container if cleanup fails
    }
  });

  it("the low-level client reads the account through the envelope", async () => {
    const me = await client.account.me();
    expect(typeof me.accountId).toBe("number");
    expect(me.serverTime).toBeTruthy();
  });

  it("sync() creates the container + task and starts it (server-side reconcile)", async () => {
    const res = await app.sync();
    expect(res.jobCreated).toBe(true);
    expect(res.created).toBeGreaterThanOrEqual(1);
    expect(res.jobId).toMatch(/^job_/);
    // The created task is ACTIVE (sync starts the disabled task).
    const tasks = await client.jobs.listTasks(res.jobId);
    const task = tasks.find((t) => t.name === "e2e-ping");
    expect(task?.status).toBe("ACTIVE");
    expect(task?.hasTargetToken).toBe(true);
  });

  it("sync() again is idempotent (no changes the second time)", async () => {
    const res = await app.sync();
    expect(res.created).toBe(0);
    expect(res.deleted).toBe(0);
    expect(res.unchanged + res.updated).toBeGreaterThanOrEqual(1);
  });

  it("sync({ dryRun }) reports no-op without mutating", async () => {
    const res = await app.sync({ dryRun: true });
    expect(res.created).toBe(0);
    expect(res.deleted).toBe(0);
  });

  it("trigger() runs the handler locally and returns its result", async () => {
    const result = await app.trigger("e2e-ping");
    expect(triggered).toBe(true);
    expect(result).toEqual({ pong: true });
  });
});

describe.skipIf(RUN)("live e2e (skipped — set CRONVELLO_E2E=1 and CRONVELLO_API_KEY to run)", () => {
  it("is intentionally skipped", () => {
    expect(true).toBe(true);
  });
});
