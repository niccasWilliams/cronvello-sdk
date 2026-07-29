import { describe, expect, it } from "vitest";
import {
  parseCron,
  nextOccurrence,
  previewSchedule,
  upcomingFires,
} from "../../src/internal/cron-schedule.js";

/** Build a deterministic UTC epoch for `from` so no test depends on the wall clock. */
function at(iso: string): number {
  return Date.parse(iso);
}

describe("parseCron — field expansion", () => {
  it("expands a basic 5-field expression", () => {
    const p = parseCron("30 9 * * 1-5");
    expect([...p.minutes]).toEqual([30]);
    expect([...p.hours]).toEqual([9]);
    expect([...p.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(p.domRestricted).toBe(false);
    expect(p.dowRestricted).toBe(true);
    expect([...p.seconds]).toEqual([0]); // implicit seconds for a 5-field expr
  });

  it("expands steps, lists and ranges", () => {
    expect([...parseCron("*/15 * * * *").minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCron("0 9-11,17 * * *").hours].sort((a, b) => a - b)).toEqual([9, 10, 11, 17]);
    expect([...parseCron("5/20 * * * *").minutes].sort((a, b) => a - b)).toEqual([5, 25, 45]);
  });

  it("accepts month and weekday names and folds Sunday-7 to 0", () => {
    expect([...parseCron("0 0 1 jan,dec *").months].sort((a, b) => a - b)).toEqual([1, 12]);
    expect([...parseCron("0 0 * * sun").daysOfWeek]).toEqual([0]);
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
  });

  it("supports a 6-field (seconds) expression", () => {
    const p = parseCron("*/30 * * * * *");
    expect([...p.seconds].sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it("expands the @-macros and flags @reboot", () => {
    const daily = parseCron("@daily");
    expect([...daily.hours]).toEqual([0]);
    expect([...daily.minutes]).toEqual([0]);
    expect(parseCron("@reboot").reboot).toBe(true);
  });

  it("throws on a malformed expression", () => {
    expect(() => parseCron("99 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * *")).toThrow(/expected 5 fields/);
    expect(() => parseCron("@nope")).toThrow(/unknown cron macro/);
  });
});

describe("nextOccurrence — basic matching", () => {
  it("finds the next minute boundary", () => {
    const next = nextOccurrence("*/15 * * * *", { from: at("2026-06-01T10:07:30Z"), timeZone: "UTC" });
    expect(next?.toISOString()).toBe("2026-06-01T10:15:00.000Z");
  });

  it("is strictly after `from` when `from` sits exactly on a fire", () => {
    const next = nextOccurrence("0 * * * *", { from: at("2026-06-01T10:00:00Z"), timeZone: "UTC" });
    expect(next?.toISOString()).toBe("2026-06-01T11:00:00.000Z");
  });

  it("rolls into the next day", () => {
    const next = nextOccurrence("0 8 * * *", { from: at("2026-06-01T09:00:00Z"), timeZone: "UTC" });
    expect(next?.toISOString()).toBe("2026-06-02T08:00:00.000Z");
  });

  it("honours day-of-week", () => {
    // 2026-06-01 is a Monday; next Wednesday 09:00 is 2026-06-03.
    const next = nextOccurrence("0 9 * * wed", { from: at("2026-06-01T00:00:00Z"), timeZone: "UTC" });
    expect(next?.toISOString()).toBe("2026-06-03T09:00:00.000Z");
  });

  it("ORs day-of-month and day-of-week when both are restricted (Vixie semantics)", () => {
    // Fire on the 15th OR any Monday. From Wed 2026-06-03, the next Monday (the 8th) wins.
    const next = nextOccurrence("0 0 15 * 1", { from: at("2026-06-03T00:00:00Z"), timeZone: "UTC" });
    expect(next?.toISOString()).toBe("2026-06-08T00:00:00.000Z");
  });

  it("handles a 6-field seconds schedule", () => {
    const next = nextOccurrence("*/30 * * * * *", { from: at("2026-06-01T10:00:05Z"), timeZone: "UTC" });
    expect(next?.toISOString()).toBe("2026-06-01T10:00:30.000Z");
  });

  it("returns null when nothing matches within the horizon (Feb 30)", () => {
    expect(nextOccurrence("0 0 30 2 *", { from: at("2026-01-01T00:00:00Z"), timeZone: "UTC" })).toBeNull();
  });

  it("throws for @reboot", () => {
    expect(() => nextOccurrence("@reboot")).toThrow(/@reboot/);
  });
});

describe("nextOccurrence — timezone & DST", () => {
  it("interprets the schedule in the job's timezone", () => {
    // 08:00 in Europe/Berlin (UTC+2 in June) is 06:00 UTC.
    const next = nextOccurrence("0 8 * * *", { from: at("2026-06-01T00:00:00Z"), timeZone: "Europe/Berlin" });
    expect(next?.toISOString()).toBe("2026-06-01T06:00:00.000Z");
  });

  it("keeps a daily job at the same wall-clock time across the spring-forward switch (23h gap)", () => {
    // Europe/Berlin springs forward 2026-03-29 (02:00 → 03:00). A daily 04:00 job fires at
    // 03:00 UTC on the 28th (CET, +1) and 02:00 UTC on the 29th (CEST, +2) — 23 hours apart, even
    // though the wall-clock time stays 04:00 both days.
    const before = nextOccurrence("0 4 * * *", { from: at("2026-03-27T12:00:00Z"), timeZone: "Europe/Berlin" });
    const after = nextOccurrence("0 4 * * *", { from: before!.getTime(), timeZone: "Europe/Berlin" });
    expect(before?.toISOString()).toBe("2026-03-28T03:00:00.000Z");
    expect(after?.toISOString()).toBe("2026-03-29T02:00:00.000Z");
    expect(after!.getTime() - before!.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("keeps a daily job at the same wall-clock time across the autumn-back switch (25h gap)", () => {
    // Europe/Berlin falls back 2026-10-25 (03:00 → 02:00). A daily 04:00 job: 02:00 UTC on the
    // 24th (CEST, +2) then 03:00 UTC on the 25th (CET, +1) — 25 hours apart.
    const before = nextOccurrence("0 4 * * *", { from: at("2026-10-23T12:00:00Z"), timeZone: "Europe/Berlin" });
    const after = nextOccurrence("0 4 * * *", { from: before!.getTime(), timeZone: "Europe/Berlin" });
    expect(before?.toISOString()).toBe("2026-10-24T02:00:00.000Z");
    expect(after?.toISOString()).toBe("2026-10-25T03:00:00.000Z");
    expect(after!.getTime() - before!.getTime()).toBe(25 * 60 * 60 * 1000);
  });
});

describe("previewSchedule", () => {
  it("returns the next N fire times in order", () => {
    const times = previewSchedule("0 0 * * *", { from: at("2026-06-01T12:00:00Z"), timeZone: "UTC", count: 3 });
    expect(times.map((t) => t.toISOString())).toEqual([
      "2026-06-02T00:00:00.000Z",
      "2026-06-03T00:00:00.000Z",
      "2026-06-04T00:00:00.000Z",
    ]);
  });

  it("defaults to 5 and caps the count", () => {
    expect(previewSchedule("* * * * *", { from: at("2026-06-01T00:00:00Z") })).toHaveLength(5);
  });
});

describe("upcomingFires", () => {
  it("merges and sorts fires across jobs within the window", () => {
    const fires = upcomingFires(
      [
        { key: "a", schedule: "*/30 * * * *", timeZone: "UTC" },
        { key: "b", schedule: "*/20 * * * *", timeZone: "UTC" },
      ],
      { from: at("2026-06-01T10:00:00Z"), withinMs: 60 * 60 * 1000 },
    );
    const seq = fires.map((f) => `${f.key}@${f.time.toISOString().slice(11, 16)}`);
    // a: :30, :00(next hr is excluded — window is exactly 60m from :00 → :40,:20,:00? check below)
    expect(seq[0]).toBe("b@10:20");
    expect(seq[1]).toBe("a@10:30");
    expect(seq[2]).toBe("b@10:40");
    // every fire is within the window
    expect(fires.every((f) => f.time.getTime() <= at("2026-06-01T11:00:00Z"))).toBe(true);
  });

  it("skips unparseable and @reboot jobs", () => {
    const fires = upcomingFires(
      [
        { key: "bad", schedule: "not a cron", timeZone: "UTC" },
        { key: "boot", schedule: "@reboot", timeZone: "UTC" },
      ],
      { from: at("2026-06-01T10:00:00Z") },
    );
    expect(fires).toHaveLength(0);
  });
});
