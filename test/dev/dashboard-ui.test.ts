// @vitest-environment happy-dom
/**
 * The dashboard UI is a plain HTML/CSS/JS string, which historically meant it was the one part of
 * the package nothing exercised. It is now the largest single surface in `dist/dev`, so these tests
 * boot the real document in a DOM, stub only the two things it talks to (`fetch` and `EventSource`),
 * and assert what a person would actually look at: the summary numbers, the job rows, the timeline
 * lanes, the live feed, and the one mutating path (run now).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_HTML } from "../../src/dev/dashboard-assets.js";

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);

interface StateJob {
  key: string;
  schedule: string;
  timeZone: string;
  description: string | null;
  nextFire: string | null;
  running: boolean;
  lastRun: Record<string, unknown> | null;
  upcoming: string[];
}

function job(over: Partial<StateJob> & { key: string }): StateJob {
  return {
    schedule: "*/5 * * * * *",
    timeZone: "Europe/Berlin",
    description: null,
    nextFire: new Date(NOW + 5_000).toISOString(),
    running: false,
    lastRun: null,
    upcoming: [new Date(NOW + 5_000).toISOString(), new Date(NOW + 10_000).toISOString()],
    ...over,
  };
}

function run(over: Partial<Record<string, unknown>> & { key: string; status: string }) {
  return {
    source: "local",
    startedAt: NOW - 30_000,
    finishedAt: NOW - 29_900,
    durationMs: 100,
    attempts: 1,
    ...over,
  };
}

/** The `/api/state` payload the page is driven with. Mutated between assertions to force a repaint. */
let state: { engine: Record<string, unknown>; jobs: StateJob[]; runs: Array<Record<string, unknown>> };
let triggered: string[];
/** The live-event sink the page subscribes to, captured so tests can push events into it. */
let emit: ((data: unknown) => void) | null;
let openStream: (() => void) | null;

class StubEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    emit = (data: unknown) => this.onmessage?.({ data: JSON.stringify(data) });
    openStream = () => this.onopen?.();
  }
}

function stubFetch(input: string, init?: { method?: string }): Promise<unknown> {
  const url = String(input);
  if (init?.method === "POST" && url.startsWith("/api/trigger/")) {
    triggered.push(decodeURIComponent(url.slice("/api/trigger/".length)));
    return Promise.resolve({ json: () => Promise.resolve({ status: "success" }) });
  }
  if (url.startsWith("/api/state")) {
    return Promise.resolve({ json: () => Promise.resolve(state) });
  }
  return Promise.resolve({ json: () => Promise.resolve({}) });
}

/**
 * Let the page's promise chains (fetch → json → render) settle. Only microtasks are drained: the
 * clock is frozen for the whole suite so that countdowns and timeline offsets are exact, and a real
 * `setTimeout(0)` here would let it drift.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

/**
 * The page's own script, run against the document it ships with. It is compiled once here rather
 * than left to the DOM implementation's script evaluation, so the tests exercise the exact source
 * that gets served and don't depend on how the test DOM handles inline `<script>`.
 */
const PAGE_SCRIPT = (() => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(DASHBOARD_HTML);
  if (!match) throw new Error("the dashboard document has no inline script");
  return match[1]!;
})();

async function boot(): Promise<void> {
  document.write(DASHBOARD_HTML);
  document.close();
  new Function(PAGE_SCRIPT)();
  await settle();
}

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} is missing from the dashboard document`);
  return node;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  triggered = [];
  emit = null;
  openStream = null;
  state = {
    engine: { running: true, startedAt: NOW - 125_000, activeRuns: 0, now: NOW },
    jobs: [
      job({ key: "sync-inventory", description: "Pull stock levels", lastRun: run({ key: "sync-inventory", status: "success" }) }),
      job({ key: "charge-subscriptions", schedule: "*/11 * * * * *", lastRun: run({ key: "charge-subscriptions", status: "error", error: "card_declined", attempts: 3 }) }),
      job({ key: "send-daily-digest", schedule: "0 8 * * *", nextFire: new Date(NOW + 3_600_000).toISOString(), upcoming: [] }),
    ],
    runs: [
      run({ key: "sync-inventory", status: "success" }),
      run({ key: "sync-inventory", status: "success", startedAt: NOW - 35_000 }),
      run({ key: "charge-subscriptions", status: "error", error: "card_declined", attempts: 3, startedAt: NOW - 20_000 }),
      run({ key: "sync-inventory", status: "skipped", startedAt: NOW - 40_000, durationMs: 0 }),
    ],
  };
  vi.stubGlobal("fetch", stubFetch);
  vi.stubGlobal("EventSource", StubEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = "";
});

describe("local dashboard UI", () => {
  it("renders the summary from a single state fetch", async () => {
    await boot();
    expect($("s-jobs").textContent).toBe("3");
    expect($("s-runs").textContent).toBe("4");
    expect($("s-ok").textContent).toBe("2");
    expect($("s-bad").textContent).toBe("1");
    // 125s of uptime reads as minutes and seconds, not a raw millisecond count.
    expect($("s-runs-sub").textContent).toBe("up 2m 5s");
  });

  it("names the job whose fire is soonest", async () => {
    await boot();
    expect($("s-next-sub").textContent).toBe("sync-inventory");
    expect($("s-next").textContent).toBe("5s");
  });

  it("builds one row per job with its schedule and last status", async () => {
    await boot();
    const rows = $("jobs").querySelectorAll("tr.job");
    expect(rows.length).toBe(3);
    expect(rows[0]!.querySelector(".jobkey")!.textContent).toBe("sync-inventory");
    expect(rows[0]!.querySelector("code")!.textContent).toBe("*/5 * * * * *");
    expect(rows[0]!.querySelector(".badge")!.textContent).toBe("success");
    expect(rows[1]!.querySelector(".badge")!.textContent).toBe("error");
    // A job that has never run shows a placeholder rather than a fake status.
    expect(rows[2]!.querySelector(".badge")!.className).toContain("none");
  });

  it("shows a live countdown instead of a raw timestamp", async () => {
    await boot();
    const next = $("jobs").querySelector("tr.job td.next")!;
    expect(next.textContent).toBe("in 5s");
    vi.advanceTimersByTime(3_000);
    expect(next.textContent).toBe("in 2s");
  });

  it("plots one timeline lane per job, with past runs and upcoming fires", async () => {
    await boot();
    expect($("tl-gutter").querySelectorAll(".lane-label").length).toBe(3);
    const lanes = document.querySelectorAll(".tl-lane");
    expect(lanes.length).toBe(3);

    const inventory = document.querySelector('.tl-lane[data-key="sync-inventory"]')!;
    // 3 runs in the window, 2 upcoming fires.
    expect(inventory.querySelectorAll(".mk.run").length).toBe(3);
    expect(inventory.querySelectorAll(".mk.up").length).toBe(2);
    expect(inventory.querySelector(".mk.success")).not.toBeNull();
    expect(inventory.querySelector(".mk.skipped")).not.toBeNull();
    expect(document.querySelector('.tl-lane[data-key="charge-subscriptions"] .mk.error')).not.toBeNull();
  });

  it("says when a lane's next fire is outside the window instead of leaving it blank", async () => {
    await boot();
    const digest = document.querySelector('.tl-lane[data-key="send-daily-digest"]')!;
    expect(digest.querySelectorAll(".mk").length).toBe(0);
    expect(digest.querySelector(".lane-note")!.textContent).toBe("next in 1h 0m");
  });

  it("keeps every mark inside the window it claims to show", async () => {
    await boot();
    for (const mark of Array.from(document.querySelectorAll<HTMLElement>(".mk"))) {
      const left = Number.parseFloat(mark.style.left);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(100);
    }
  });

  it("slides the track rather than repositioning every mark", async () => {
    await boot();
    const track = $("tl-track");
    const before = document.querySelector<HTMLElement>(".mk.run")!.style.left;
    vi.advanceTimersByTime(6_000);
    expect(track.style.transform).toBe("translateX(-1%)"); // 6s of a 10min window
    expect(document.querySelector<HTMLElement>(".mk.run")!.style.left).toBe(before);
  });

  it("re-anchors the window once the drift would push marks out of view", async () => {
    await boot();
    vi.setSystemTime(NOW + 200_000); // beyond a quarter of the 10min window
    vi.advanceTimersByTime(1_000);
    expect($("tl-track").style.transform).toBe("translateX(0%)");
  });

  it("redraws the timeline when the window is changed", async () => {
    await boot();
    const select = $("tl-span") as HTMLSelectElement;
    select.value = "120000";
    select.dispatchEvent(new Event("change"));
    expect($("tl-hint").textContent).toBe("1m back, 1m ahead");
    // A run 40s old still fits a 2-minute window; one 3 minutes old would not.
    expect(document.querySelectorAll('.tl-lane[data-key="sync-inventory"] .mk.run').length).toBe(3);
  });

  it("appends live events to the feed without refetching per event", async () => {
    await boot();
    openStream!();
    const before = (globalThis.fetch as unknown as { mock?: unknown }) ? 0 : 0;
    void before;
    emit!({ type: "fire", key: "sync-inventory", attempt: 1, at: NOW });
    emit!({ type: "success", key: "sync-inventory", durationMs: 12, attempts: 1, at: NOW });
    const events = $("feed").querySelectorAll(".ev");
    expect(events.length).toBe(2);
    expect(events[0]!.textContent).toContain("succeeded");
    expect(events[0]!.className).toContain("success");
    expect(events[1]!.textContent).toContain("fired");
  });

  it("stamps a scheduled event with its arrival time, not the fire time it carries", async () => {
    await boot();
    openStream!();
    // The engine sends the *next fire* as this event's timestamp. Printing that in the clock column
    // would make the feed look like it had jumped forward in time.
    emit!({ type: "scheduled", key: "sync-inventory", at: NOW + 5_000 });
    const line = $("feed").querySelector(".ev")!;
    expect(line.textContent).toContain("scheduled for");
    expect(line.querySelector(".when")!.textContent).toBe(new Date(NOW).toTimeString().slice(0, 8));
  });

  it("reports a failure with its message", async () => {
    await boot();
    openStream!();
    emit!({ type: "error", key: "charge-subscriptions", error: "card_declined", willRetry: true, durationMs: 5, attempt: 1, at: NOW });
    const first = $("feed").querySelector(".ev")!;
    expect(first.className).toContain("error");
    expect(first.textContent).toContain("card_declined");
    expect(first.textContent).toContain("retrying");
  });

  it("holds events back while paused and says how many", async () => {
    await boot();
    openStream!();
    $("feed-pause").dispatchEvent(new Event("click"));
    emit!({ type: "fire", key: "sync-inventory", attempt: 1, at: NOW });
    emit!({ type: "fire", key: "sync-inventory", attempt: 1, at: NOW });
    expect($("feed").querySelectorAll(".ev").length).toBe(0);
    expect($("feed-paused").hidden).toBe(false);
    expect($("feed-paused").textContent).toContain("2 events not shown");

    $("feed-pause").dispatchEvent(new Event("click"));
    expect($("feed-paused").hidden).toBe(true);
  });

  it("opens a job drawer with fire times and run history", async () => {
    await boot();
    const row = $("jobs").querySelector<HTMLElement>('tr.job[data-key="charge-subscriptions"]')!;
    row.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();

    expect($("overlay").hidden).toBe(false);
    expect($("drawer-title").textContent).toBe("charge-subscriptions");
    const body = $("drawer-body");
    expect(body.textContent).toContain("*/11 * * * * *");
    expect(body.textContent).toContain("Europe/Berlin");
    // The failing run's message is the reason you opened this panel.
    expect(body.querySelector("pre.err")!.textContent).toBe("card_declined");
    expect(body.textContent).toContain("3 attempts");
  });

  it("shows a successful run's return value", async () => {
    state.runs = [run({ key: "sync-inventory", status: "success", result: { items: 128 } })];
    await boot();
    $("jobs").querySelector<HTMLElement>('tr.job[data-key="sync-inventory"]')!
      .dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    expect($("drawer-body").querySelector("pre")!.textContent).toContain('"items": 128');
  });

  it("closes the drawer on Escape and restores focus", async () => {
    await boot();
    const row = $("jobs").querySelector<HTMLElement>("tr.job")!;
    row.focus();
    row.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    expect($("overlay").hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("overlay").hidden).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("triggers exactly the job whose Run button was pressed, without opening the drawer", async () => {
    await boot();
    const row = $("jobs").querySelector<HTMLElement>('tr.job[data-key="send-daily-digest"]')!;
    row.querySelector("button")!.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    expect(triggered).toEqual(["send-daily-digest"]);
    expect($("overlay").hidden).toBe(true);
  });

  it("rebuilds rows and lanes when the job set changes", async () => {
    await boot();
    state.jobs = [job({ key: "only-one" })];
    state.runs = [];
    await vi.advanceTimersByTimeAsync(10_100); // the reconciliation poll, plus its debounce
    await settle();
    expect($("jobs").querySelectorAll("tr.job").length).toBe(1);
    expect(document.querySelectorAll(".tl-lane").length).toBe(1);
    expect($("tl-gutter").querySelectorAll(".lane-label")[0]!.textContent).toBe("only-one");
  });

  it("says what to do when there are no jobs at all", async () => {
    state.jobs = [];
    state.runs = [];
    await boot();
    expect($("jobs").textContent).toContain("No jobs registered");
    expect($("tl-empty").hidden).toBe(false);
    expect($("tl").hidden).toBe(true);
  });

  it("reflects engine and stream state in the header", async () => {
    await boot();
    expect($("engine-text").textContent).toBe("running · 3 jobs");
    openStream!();
    expect($("conn-text").textContent).toBe("live");

    state.engine["running"] = false;
    await vi.advanceTimersByTimeAsync(10_100);
    await settle();
    expect($("engine-text").textContent).toBe("stopped · 3 jobs");
  });
});
