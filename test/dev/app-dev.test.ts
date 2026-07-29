import { describe, expect, it } from "vitest";
import { defineCronvello } from "../../src/registry/define.js";
import { FakeClock } from "../helpers/fake-clock.js";

const DAY1_MIDNIGHT = Date.parse("1970-01-02T00:00:00Z");

function baseConfig() {
  return {
    appName: "test-app",
    appUrl: "https://app.example.com",
    apiKey: "crn_live_test",
    dispatchSecret: "0123456789abcdef0123456789abcdef",
    timeZone: "UTC",
  };
}

describe("app.dev() — local engine wiring", () => {
  it("runs a job's handler locally through the engine, with hooks (source: local)", async () => {
    const clock = new FakeClock(0);
    const ran: string[] = [];
    const sources: string[] = [];
    const app = defineCronvello({
      ...baseConfig(),
      hooks: { onJobStart: ({ source }) => void sources.push(source) },
      jobs: {
        nightly: { schedule: "0 0 * * *", handler: async ({ source }) => { ran.push(source); return 42; } },
      },
    });

    const engine = app.dev({ clock, autoStart: false });
    engine.start();
    await clock.advanceTo(DAY1_MIDNIGHT);

    expect(ran).toEqual(["local"]);
    expect(sources).toEqual(["local"]); // hook fired
    expect(engine.runs()[0]).toMatchObject({ key: "nightly", status: "success", result: 42 });
    await engine.stop();
  });

  it("inherits per-job timezone and the app default, and skips disabled jobs", async () => {
    const clock = new FakeClock(0);
    const app = defineCronvello({
      ...baseConfig(),
      timeZone: "UTC",
      jobs: {
        berlin: { schedule: "0 8 * * *", timeZone: "Europe/Berlin", handler: async () => undefined },
        utc: { schedule: "0 8 * * *", handler: async () => undefined },
        off: { schedule: "0 8 * * *", enabled: false, handler: async () => undefined },
      },
    });

    const engine = app.dev({ clock, autoStart: false });
    const snap = engine.snapshot();
    expect(snap.map((s) => s.key)).toEqual(["berlin", "utc"]); // disabled job excluded
    expect(snap.find((s) => s.key === "berlin")!.timeZone).toBe("Europe/Berlin");
    expect(snap.find((s) => s.key === "utc")!.timeZone).toBe("UTC");
  });

  it("autoStart defaults to true", async () => {
    const clock = new FakeClock(0);
    const app = defineCronvello({
      ...baseConfig(),
      jobs: { nightly: { schedule: "0 0 * * *", handler: async () => "ok" } },
    });
    const engine = app.dev({ clock });
    await clock.advanceTo(DAY1_MIDNIGHT);
    expect(engine.runs()).toHaveLength(1);
    await engine.stop();
  });
});
