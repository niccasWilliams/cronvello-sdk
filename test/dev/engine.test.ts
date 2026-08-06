import { describe, expect, it, vi } from "vitest";
import { createLocalEngine, type EngineEvent, type EngineJob, type EngineRunner } from "../../src/dev/engine.js";
import { FakeClock, deferred } from "../helpers/fake-clock.js";

const DAY1_MIDNIGHT = Date.parse("1970-01-02T00:00:00Z"); // first "0 0 * * *" fire from epoch 0

/** Spin up an engine on a virtual clock and collect its events. */
function harness(jobs: EngineJob[], runner: EngineRunner, opts: { historyLimit?: number; backoff?: (n: number) => number } = {}) {
  const clock = new FakeClock(0);
  const events: EngineEvent[] = [];
  const engine = createLocalEngine(jobs, runner, {
    clock,
    onEvent: (e) => events.push(e),
    ...(opts.historyLimit !== undefined ? { historyLimit: opts.historyLimit } : {}),
    ...(opts.backoff ? { backoff: opts.backoff } : {}),
  });
  return { clock, events, engine };
}

const everySecond = (over: Partial<EngineJob> = {}): EngineJob => ({ key: "tick", schedule: "* * * * * *", timeZone: "UTC", ...over });
const daily = (over: Partial<EngineJob> = {}): EngineJob => ({ key: "nightly", schedule: "0 0 * * *", timeZone: "UTC", ...over });

describe("LocalEngine — firing", () => {
  it("computes a next fire time and runs the handler when due", async () => {
    const calls: string[] = [];
    const { clock, engine } = harness([daily()], async (key) => {
      calls.push(key);
      return { ok: true };
    });
    engine.start();

    // Before the fire, the snapshot shows the scheduled time and nothing has run.
    expect(engine.snapshot()[0]!.nextFire?.toISOString()).toBe("1970-01-02T00:00:00.000Z");
    expect(calls).toHaveLength(0);

    await clock.advanceTo(DAY1_MIDNIGHT);

    expect(calls).toEqual(["nightly"]);
    const runs = engine.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: "nightly", status: "success", attempts: 1, result: { ok: true } });
    await engine.stop();
  });

  it("leaves a never-matching schedule unscheduled (no fire, nextFire null)", async () => {
    const calls: string[] = [];
    const { clock, engine } = harness([{ key: "feb30", schedule: "0 0 30 2 *", timeZone: "UTC" }], async (k) => void calls.push(k));
    engine.start();
    expect(engine.snapshot()[0]!.nextFire).toBeNull();
    await clock.advanceTo(10 * DAY1_MIDNIGHT);
    expect(calls).toHaveLength(0);
    await engine.stop();
  });

  it("tolerates an unparseable schedule without crashing the loop", async () => {
    const { clock, engine } = harness([{ key: "broken", schedule: "totally not cron", timeZone: "UTC" }], async () => undefined);
    engine.start();
    expect(engine.snapshot()[0]!.nextFire).toBeNull();
    await clock.advanceTo(DAY1_MIDNIGHT);
    expect(engine.runs()).toHaveLength(0);
    await engine.stop();
  });

  it("fires @reboot once at start and never reschedules it", async () => {
    const calls: string[] = [];
    const { clock, engine } = harness([{ key: "boot", schedule: "@reboot", timeZone: "UTC" }], async (key) => {
      calls.push(key);
    });
    engine.start();
    await clock.advanceTo(10 * DAY1_MIDNIGHT);
    expect(calls).toEqual(["boot"]);
    expect(engine.snapshot()[0]!.nextFire).toBeNull();
    await engine.stop();
  });
});

describe("LocalEngine — preventOverlap", () => {
  it("skips a fire while a previous run is still in flight", async () => {
    const gate = deferred();
    let starts = 0;
    const { clock, events, engine } = harness([everySecond()], async () => {
      starts++;
      await gate.promise;
    });
    engine.start();

    await clock.advanceTo(1000); // first fire → run starts and blocks on the gate
    expect(starts).toBe(1);
    await clock.advanceTo(2000); // second fire → previous still running → skipped
    expect(starts).toBe(1);

    expect(events.some((e) => e.type === "skipped" && e.reason === "overlap")).toBe(true);
    expect(engine.runs().some((r) => r.status === "skipped")).toBe(true);

    gate.resolve();
    await engine.stop();
    expect(engine.runs().some((r) => r.status === "success")).toBe(true);
  });

  it("allows concurrent runs when allowConcurrentRuns is set", async () => {
    const gate = deferred();
    let starts = 0;
    const { clock, engine } = harness([everySecond({ allowConcurrentRuns: true })], async () => {
      starts++;
      await gate.promise;
    });
    engine.start();
    await clock.advanceTo(1000);
    await clock.advanceTo(2000);
    expect(starts).toBe(2); // both fires started despite the first still being in flight
    gate.resolve();
    await engine.stop();
  });
});

describe("LocalEngine — timeout", () => {
  it("aborts and records a timed-out run when the handler exceeds its budget", async () => {
    let aborted = false;
    const { clock, events, engine } = harness([daily({ timeoutMs: 5000 })], (_key, signal) =>
      new Promise(() => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      }),
    );
    engine.start();
    await clock.advanceTo(DAY1_MIDNIGHT); // fire — handler hangs
    await clock.advanceTo(DAY1_MIDNIGHT + 5000); // cross the timeout

    expect(aborted).toBe(true);
    const runs = engine.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: "nightly", status: "timed_out", attempts: 1 });
    expect(events.some((e) => e.type === "timeout")).toBe(true);
    await engine.stop();
  });
});

describe("LocalEngine — retry & backoff", () => {
  it("retries a failing handler with backoff, then records the eventual success", async () => {
    let attempt = 0;
    const { clock, events, engine } = harness(
      [daily({ maxRetries: 2 })],
      async () => {
        attempt++;
        if (attempt < 3) throw new Error(`boom ${attempt}`);
        return "recovered";
      },
      { backoff: () => 1000 },
    );
    engine.start();
    await clock.advanceTo(DAY1_MIDNIGHT + 5000); // fire + two backoff windows

    expect(attempt).toBe(3);
    const runs = engine.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: "nightly", status: "success", attempts: 3, result: "recovered" });

    const retryEvents = events.filter((e) => e.type === "retry");
    expect(retryEvents).toHaveLength(2);
    await engine.stop();
  });

  it("gives up after exhausting retries and records the failure", async () => {
    const { clock, engine } = harness(
      [daily({ maxRetries: 1 })],
      async () => {
        throw new Error("always fails");
      },
      { backoff: () => 500 },
    );
    engine.start();
    await clock.advanceTo(DAY1_MIDNIGHT + 5000);

    const runs = engine.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: "nightly", status: "error", attempts: 2, error: "always fails" });
    await engine.stop();
  });
});

describe("LocalEngine — run history", () => {
  it("keeps a bounded ring buffer, newest first", async () => {
    const { clock, engine } = harness([everySecond()], async () => "ok", { historyLimit: 3 });
    engine.start();
    await clock.advanceTo(6000); // six fires

    const runs = engine.runs();
    expect(runs).toHaveLength(3); // capped
    // Newest first: the last fires (around :06, :05, :04) survive; all succeeded.
    expect(runs.every((r) => r.status === "success")).toBe(true);
    expect(runs[0]!.startedAt).toBeGreaterThan(runs[2]!.startedAt);
    expect(engine.runsFor("tick")).toHaveLength(3);
    await engine.stop();
  });
});

describe("LocalEngine — shutdown", () => {
  it("stop() clears timers and waits for in-flight runs", async () => {
    const gate = deferred();
    let finished = false;
    const { clock, engine } = harness([everySecond()], async () => {
      await gate.promise;
      finished = true;
    });
    engine.start();
    await clock.advanceTo(1000); // a run is in flight

    const stopping = engine.stop();
    gate.resolve();
    await stopping;

    expect(finished).toBe(true);
    expect(clock.pending()).toBe(0); // no dangling timers
    expect(engine.activeRuns).toBe(0);
  });

  it("does not start new runs after stop()", async () => {
    const run = vi.fn(async () => "ok");
    const { clock, engine } = harness([everySecond()], run);
    engine.start();
    await clock.advanceTo(1000);
    await engine.stop();
    const callsAfterStop = run.mock.calls.length;
    await clock.advanceTo(10_000);
    expect(run.mock.calls.length).toBe(callsAfterStop);
  });
});

describe("LocalEngine — subscribe()", () => {
  it("delivers events to extra subscribers and stops after unsubscribe", async () => {
    const { clock, engine } = harness([everySecond()], async () => "ok");
    const seen: EngineEvent[] = [];
    const unsubscribe = engine.subscribe((e) => seen.push(e));

    engine.start();
    await clock.advanceTo(1000);
    expect(seen.some((e) => e.type === "success")).toBe(true);

    const countAtUnsub = seen.length;
    unsubscribe();
    await clock.advanceTo(3000);
    expect(seen.length).toBe(countAtUnsub); // no further events after unsubscribe
    await engine.stop();
  });

  it("isolates a throwing subscriber from the scheduler", async () => {
    const run = vi.fn(async () => "ok");
    const { clock, engine } = harness([everySecond()], run);
    engine.subscribe(() => {
      throw new Error("bad listener");
    });
    engine.start();
    await clock.advanceTo(2000);
    expect(run.mock.calls.length).toBeGreaterThan(0); // scheduler kept going despite the throw
    await engine.stop();
  });
});

describe("LocalEngine — onStop() hooks", () => {
  it("awaits shutdown hooks during stop(), after draining runs", async () => {
    const order: string[] = [];
    const gate = deferred();
    const { clock, engine } = harness([everySecond()], async () => {
      await gate.promise;
      order.push("run-settled");
      return "ok";
    });
    engine.onStop(async () => {
      order.push("hook");
    });
    engine.start();
    await clock.advanceTo(1000); // a run is now in flight, parked on the gate

    const stopping = engine.stop();
    gate.resolve();
    await stopping;

    expect(order).toEqual(["run-settled", "hook"]); // hook runs only after the in-flight run settled
  });
});

describe("LocalEngine — trigger()", () => {
  it("runs a job once on demand and records it", async () => {
    const run = vi.fn(async () => ({ ran: true }));
    const { engine } = harness([daily()], run);
    engine.start();

    const record = await engine.trigger("nightly");
    expect(run).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({ key: "nightly", status: "success", attempts: 1, result: { ran: true } });
    expect(engine.runsFor("nightly")).toHaveLength(1);
    await engine.stop();
  });

  it("rejects an unknown key and a stopped engine", async () => {
    const { engine } = harness([daily()], async () => "ok");
    engine.start();
    await expect(engine.trigger("nope")).rejects.toThrow(/unknown job/);
    await engine.stop();
    await expect(engine.trigger("nightly")).rejects.toThrow(/stopped/);
  });
});

describe("LocalEngine — toNdjson()", () => {
  it("serialises history oldest-first, one JSON record per line", async () => {
    const { engine } = harness([daily({ key: "a" }), daily({ key: "b" })], async () => "ok");
    engine.start();
    await engine.trigger("a");
    await engine.trigger("b");

    const lines = engine.toNdjson().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((r) => r.key)).toEqual(["a", "b"]); // chronological
    expect(parsed[0]).toMatchObject({ status: "success", source: "local" });
    await engine.stop();
  });

  it("is empty for an engine with no runs", () => {
    const { engine } = harness([daily()], async () => "ok");
    expect(engine.toNdjson()).toBe("");
  });

  it("exposes when it started and whether it is running", async () => {
    const clock = new FakeClock(1_000);
    const engine = createLocalEngine([{ key: "j", schedule: "* * * * *", timeZone: "UTC" }], async () => "ok", { clock });
    expect(engine.startedAt).toBeNull();
    expect(engine.running).toBe(false);

    engine.start();
    expect(engine.startedAt).toBe(1_000);
    expect(engine.running).toBe(true);

    await engine.stop();
    expect(engine.running).toBe(false);
    // The start time survives the stop, so a dashboard can still report the session length.
    expect(engine.startedAt).toBe(1_000);
  });
});
