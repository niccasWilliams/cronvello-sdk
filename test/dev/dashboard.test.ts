import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalEngine, type EngineJob, type EngineRunner, type LocalEngine } from "../../src/dev/engine.js";
import { startDashboard, type DashboardHandle } from "../../src/dev/dashboard.js";
import { FakeClock } from "../helpers/fake-clock.js";

// The dashboard is exercised over real HTTP on an ephemeral port (`port: 0`), bound to loopback, so
// the tests prove the wire format and not just the in-process calls. The engine runs on a FakeClock
// so manual triggers are deterministic without touching wall-clock time.

let handle: DashboardHandle | undefined;
let engine: LocalEngine | undefined;

afterEach(async () => {
  if (handle) await handle.close();
  if (engine) await engine.stop();
  handle = undefined;
  engine = undefined;
});

const nightly = (over: Partial<EngineJob> = {}): EngineJob => ({ key: "nightly", schedule: "0 0 * * *", timeZone: "UTC", ...over });

async function boot(jobs: EngineJob[], runner?: EngineRunner): Promise<string> {
  engine = createLocalEngine(jobs, runner ?? (async () => "ok"), { clock: new FakeClock(0) });
  engine.start();
  handle = await startDashboard(engine, { port: 0, host: "127.0.0.1" });
  return handle.url;
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

describe("dashboard — bind & landing page", () => {
  it("binds to loopback and serves the branded HTML at /", async () => {
    const base = await boot([nightly()]);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(base + "/");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Cronvello");
    expect(html).toContain("/api/events");
  });

  it("404s an unknown route", async () => {
    const base = await boot([nightly()]);
    const { status, body } = await getJson(base, "/api/nope");
    expect(status).toBe(404);
    expect(body.error).toBeTruthy();
  });
});

describe("dashboard — read API", () => {
  it("GET /api/health reports job count", async () => {
    const base = await boot([nightly(), nightly({ key: "hourly", schedule: "0 * * * *" })]);
    const { status, body } = await getJson(base, "/api/health");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, jobs: 2, activeRuns: 0 });
  });

  it("GET /api/jobs returns the snapshot with nextFire as an ISO string", async () => {
    const base = await boot([nightly()]);
    const { body } = await getJson(base, "/api/jobs");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ key: "nightly", schedule: "0 0 * * *", timeZone: "UTC", running: false });
    // FakeClock starts at epoch 0, so the first "0 0 * * *" fire is the next midnight.
    expect(body[0].nextFire).toBe("1970-01-02T00:00:00.000Z");
  });

  it("GET /api/preview/:key returns exactly N upcoming fire times", async () => {
    const base = await boot([nightly()]);
    const { body } = await getJson(base, "/api/preview/nightly?n=3");
    expect(body).toHaveLength(3);
    for (const iso of body) expect(() => new Date(iso).toISOString()).not.toThrow();
  });

  it("GET /api/preview/:key 404s an unknown job", async () => {
    const base = await boot([nightly()]);
    const { status } = await getJson(base, "/api/preview/ghost");
    expect(status).toBe(404);
  });

  it("GET /api/state answers with everything the page draws, in one response", async () => {
    const base = await boot([nightly(), nightly({ key: "hourly", schedule: "0 * * * *" })]);
    await engine!.trigger("nightly");
    const { status, body } = await getJson(base, "/api/state?upcoming=3");
    expect(status).toBe(200);

    expect(body.engine).toMatchObject({ running: true, activeRuns: 0 });
    expect(typeof body.engine.startedAt).toBe("number");

    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]).toMatchObject({ key: "nightly", schedule: "0 0 * * *", timeZone: "UTC" });
    expect(body.jobs[0].upcoming).toHaveLength(3);
    // The last run is folded in, so the table needs no second request to show a status.
    expect(body.jobs[0].lastRun).toMatchObject({ key: "nightly", status: "success" });
    expect(body.jobs[1].lastRun).toBeNull();

    expect(body.runs).toHaveLength(1);
  });

  it("GET /api/state reports an unschedulable expression as simply having no upcoming fires", async () => {
    const base = await boot([nightly({ key: "at-boot", schedule: "@reboot" })]);
    const { status, body } = await getJson(base, "/api/state");
    expect(status).toBe(200);
    expect(body.jobs[0].upcoming).toEqual([]);
  });
});

describe("dashboard — trigger & history", () => {
  it("POST /api/trigger/:key runs the handler and records the run", async () => {
    const run = vi.fn(async () => ({ ok: 1 }));
    const base = await boot([nightly()], run);

    const res = await fetch(base + "/api/trigger/nightly", { method: "POST" });
    expect(res.status).toBe(200);
    const record = await res.json();
    expect(record).toMatchObject({ key: "nightly", status: "success" });
    expect(run).toHaveBeenCalledTimes(1);

    const { body: runs } = await getJson(base, "/api/runs");
    expect(runs).toHaveLength(1);
    const { body: forKey } = await getJson(base, "/api/runs/nightly");
    expect(forKey).toHaveLength(1);
  });

  it("POST /api/trigger/:key 404s an unknown job", async () => {
    const base = await boot([nightly()]);
    const res = await fetch(base + "/api/trigger/ghost", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("GET /api/runs.ndjson returns one JSON record per line", async () => {
    const base = await boot([nightly()]);
    await fetch(base + "/api/trigger/nightly", { method: "POST" });
    await fetch(base + "/api/trigger/nightly", { method: "POST" });

    const res = await fetch(base + "/api/runs.ndjson");
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await res.text();
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ key: "nightly", source: "local" });
  });
});

describe("dashboard — same-origin guard", () => {
  it("rejects a cross-origin POST and never runs the handler", async () => {
    const run = vi.fn(async () => "ok");
    const base = await boot([nightly()], run);

    const res = await fetch(base + "/api/trigger/nightly", {
      method: "POST",
      headers: { origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("allows a same-origin POST", async () => {
    const base = await boot([nightly()]);
    const origin = base; // the dashboard's own origin
    const res = await fetch(base + "/api/trigger/nightly", { method: "POST", headers: { origin } });
    expect(res.status).toBe(200);
  });
});

describe("dashboard — live events (SSE)", () => {
  it("streams at least one event when a job is triggered", async () => {
    const base = await boot([nightly()]);

    // Subscribe first; the server registers the listener before this resolves.
    const stream = await fetch(base + "/api/events");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();

    // Now cause an event.
    await fetch(base + "/api/trigger/nightly", { method: "POST" });

    let buf = "";
    let sawData = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: false }), 500)),
      ]);
      if (chunk.done) break;
      if (chunk.value) buf += decoder.decode(chunk.value, { stream: true });
      if (/^data: /m.test(buf)) {
        sawData = true;
        break;
      }
    }
    await reader.cancel();
    expect(sawData).toBe(true);
    // The streamed payload is the engine's JSON event.
    const dataLine = buf.split("\n").find((l) => l.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice(6))).toHaveProperty("type");
  });
});

describe("dashboard — lifecycle", () => {
  it("close() is idempotent and stops serving", async () => {
    const base = await boot([nightly()]);
    await handle!.close();
    await handle!.close(); // second call must not throw
    await expect(fetch(base + "/api/health")).rejects.toBeTruthy();
    handle = undefined; // already closed; skip afterEach double-close
  });
});
