import { describe, expect, it } from "vitest";
import { reconcile, type ReconcileInput } from "../../src/registry/reconcile.js";
import type { CronvelloJobConfig } from "../../src/registry/types.js";
import { fakeClient, type FakeClient, type SeedTask } from "../helpers/fake-client.js";

const URL = "https://app.example.com/cronvello/dispatch";
const SECRET = "dispatch-secret-0123456789abcdef";
const TZ = "Europe/Berlin";

function job(key: string, config: Partial<CronvelloJobConfig> = {}) {
  return { key, config: { schedule: "0 8 * * *", handler: async () => undefined, ...config } };
}

function input(fc: FakeClient, jobs: ReturnType<typeof job>[], appName = "Test App"): ReconcileInput {
  return { client: fc.client, appName, dispatchUrl: URL, dispatchSecret: SECRET, defaultTimeZone: TZ, jobs };
}

/** A seed task whose fields exactly match what `buildDesiredTask` produces for a minimal job. */
function matchingSeed(key: string, schedule = "0 8 * * *"): SeedTask {
  return {
    name: key,
    schedule,
    timeZone: TZ,
    targetUrl: URL,
    method: "POST",
    requestBody: JSON.stringify({ job: key }),
    hasTargetToken: true,
    status: "ACTIVE",
  };
}

describe("reconcile — fresh app", () => {
  it("creates the container, creates each task, and starts it", async () => {
    const fc = fakeClient();
    const res = await reconcile(input(fc, [job("digest"), job("cleanup")]));

    expect(res.jobCreated).toBe(true);
    expect(res.created).toBe(2);
    expect(fc.ops).toContain("createJob:Test App");
    expect(fc.ops).toContain("createTask:digest");
    // Each created task is started (server creates them DISABLED).
    expect(fc.ops.filter((o) => o.startsWith("start:")).length).toBe(2);
    expect(fc.tasksTable.every((t) => t.status === "ACTIVE")).toBe(true);
  });

  it("builds the dispatch request body as {job:key} merged with the static payload", async () => {
    const fc = fakeClient();
    await reconcile(input(fc, [job("digest", { payload: { tenant: "acme" } })]));
    const task = fc.tasksTable.find((t) => t.name === "digest")!;
    expect(JSON.parse(task.requestBody!)).toEqual({ job: "digest", tenant: "acme" });
    expect(task.targetUrl).toBe(URL);
    expect(task.hasTargetToken).toBe(true);
  });
});

describe("reconcile — existing app diff", () => {
  it("reports unchanged when nothing differs", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [matchingSeed("digest")] });
    const res = await reconcile(input(fc, [job("digest")]));
    expect(res.unchanged).toBe(1);
    expect(res.updated).toBe(0);
    expect(fc.ops).toEqual([]); // zero mutations
  });

  it("patches only the changed fields", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [matchingSeed("digest", "0 8 * * *")] });
    const res = await reconcile(input(fc, [job("digest", { schedule: "0 9 * * *" })]));
    expect(res.updated).toBe(1);
    const change = res.changes.find((c) => c.key === "digest")!;
    expect(change.changedFields).toEqual(["schedule"]);
    expect(fc.ops.some((o) => o.startsWith("update:") && o.endsWith(":schedule"))).toBe(true);
  });

  it("re-activates a DISABLED task without other changes", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [{ ...matchingSeed("digest"), status: "DISABLED" }] });
    const res = await reconcile(input(fc, [job("digest")]));
    expect(fc.ops.some((o) => o.startsWith("start:"))).toBe(true);
    expect(res.changes.find((c) => c.key === "digest")!.reason).toBe("re-activated");
  });

  it("sets targetToken when the existing task has none", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [{ ...matchingSeed("digest"), hasTargetToken: false }] });
    const res = await reconcile(input(fc, [job("digest")]));
    expect(res.changes.find((c) => c.key === "digest")!.changedFields).toContain("targetToken");
  });

  it("rewrites the secret on every task when rotateSecret is set", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [matchingSeed("digest")] });
    const res = await reconcile(input(fc, [job("digest")]), { rotateSecret: true });
    expect(res.changes.find((c) => c.key === "digest")!.changedFields).toContain("targetToken");
  });
});

describe("reconcile — disabled jobs", () => {
  it("stops an active task that is disabled in the registry and marks it skipped", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [matchingSeed("digest")] });
    const res = await reconcile(input(fc, [job("digest", { enabled: false })]));
    expect(res.skipped).toBe(1);
    expect(fc.ops.some((o) => o.startsWith("stop:"))).toBe(true);
  });

  it("does not create a task for a job disabled from the start", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [] });
    const res = await reconcile(input(fc, [job("digest", { enabled: false })]));
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(fc.ops.filter((o) => o.startsWith("createTask")).length).toBe(0);
  });
});

describe("reconcile — pruning", () => {
  it("deletes tasks no longer in the registry by default", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [matchingSeed("keep"), matchingSeed("orphan")] });
    const res = await reconcile(input(fc, [job("keep")]));
    expect(res.deleted).toBe(1);
    expect(res.changes.find((c) => c.action === "deleted")!.key).toBe("orphan");
    expect(fc.tasksTable.some((t) => t.name === "orphan")).toBe(false);
  });

  it("leaves orphans in place when prune is false", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [matchingSeed("keep"), matchingSeed("orphan")] });
    const res = await reconcile(input(fc, [job("keep")]), { prune: false });
    expect(res.deleted).toBe(0);
    expect(fc.tasksTable.some((t) => t.name === "orphan")).toBe(true);
  });
});

describe("reconcile — dryRun", () => {
  it("computes the diff without mutating anything", async () => {
    const fc = fakeClient({ jobName: "Test App", tasks: [matchingSeed("digest", "0 8 * * *")] });
    const res = await reconcile(input(fc, [job("digest", { schedule: "0 9 * * *" }), job("new")]), { dryRun: true });
    expect(res.updated).toBe(1);
    expect(res.created).toBe(1); // "new" would be created
    expect(fc.ops).toEqual([]); // but nothing actually happened
  });

  it("treats a missing container as a full create in dryRun", async () => {
    const fc = fakeClient();
    const res = await reconcile(input(fc, [job("a"), job("b")]), { dryRun: true });
    expect(res.jobCreated).toBe(true);
    expect(res.created).toBe(2);
    expect(fc.ops).toEqual([]);
  });
});
