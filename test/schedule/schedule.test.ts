import { describe, expect, it } from "vitest";
import {
  cron, every, everyMinutes, everyHours, hourly, daily, weekly, monthly, weekdays, weekends, schedule,
} from "../../src/schedule/index.js";
import { validateCron, isValidTimeZone } from "../../src/internal/cron.js";

describe("schedule builders — happy paths", () => {
  it("every() maps units to cron", () => {
    expect(every("30s")).toBe("*/30 * * * * *");
    expect(every("15m")).toBe("*/15 * * * *");
    expect(every("2h")).toBe("0 */2 * * *");
    expect(every("1d")).toBe("0 0 * * *");
    expect(every("3d")).toBe("0 0 */3 * *");
    expect(every("5 min")).toBe("*/5 * * * *");
  });

  it("everyMinutes / everyHours", () => {
    expect(everyMinutes(10)).toBe("*/10 * * * *");
    expect(everyHours(6)).toBe("0 */6 * * *");
  });

  it("hourly / daily / weekly / monthly", () => {
    expect(hourly()).toBe("0 * * * *");
    expect(hourly(30)).toBe("30 * * * *");
    expect(daily("08:00")).toBe("0 8 * * *");
    expect(daily("23:30")).toBe("30 23 * * *");
    expect(weekly("mon", "09:00")).toBe("0 9 * * 1");
    expect(weekly("sun")).toBe("0 0 * * 0");
    expect(weekly(3, "06:15")).toBe("15 6 * * 3");
    expect(monthly(1, "00:00")).toBe("0 0 1 * *");
  });

  it("weekdays / weekends", () => {
    expect(weekdays("07:00")).toBe("0 7 * * 1-5");
    expect(weekends("10:00")).toBe("0 10 * * 0,6");
  });

  it("cron() validates and passes through", () => {
    expect(cron("0 6,7 * * *")).toBe("0 6,7 * * *");
  });

  it("the namespace form exposes the same builders", () => {
    expect(schedule.daily("08:00")).toBe(daily("08:00"));
  });
});

describe("schedule builders — rejects bad input", () => {
  it("every() rejects garbage and out-of-range", () => {
    expect(() => every("soon")).toThrow(/cannot parse/);
    expect(() => every("0m")).toThrow(/at least 1/);
    expect(() => every("90m")).toThrow(/1.59/);
    expect(() => every("30h")).toThrow(/1.23/);
    expect(() => every("90s")).toThrow(/1.59/);
  });
  it("time parsing rejects malformed and out-of-range times", () => {
    expect(() => daily("8am")).toThrow(/Expected a time/);
    expect(() => daily("25:00")).toThrow(/0.23/);
    expect(() => daily("08:99")).toThrow(/0.59/);
  });
  it("weekly rejects unknown weekdays", () => {
    // @ts-expect-error invalid weekday
    expect(() => weekly("funday", "09:00")).toThrow(/Unknown weekday/);
    // @ts-expect-error out-of-range number
    expect(() => weekly(9, "09:00")).toThrow(/0 \(Sun\)/);
  });
  it("monthly / hourly reject out-of-range fields", () => {
    expect(() => monthly(40, "00:00")).toThrow(/1.31/);
    expect(() => hourly(99)).toThrow(/0.59/);
  });
});

describe("validateCron", () => {
  it("accepts standard expressions, macros, names, lists, ranges, steps", () => {
    for (const ok of ["0 8 * * *", "*/15 * * * *", "0 6,7 * * *", "0 9 * * 1-5", "@daily", "@hourly", "0 0 1 jan *", "0 0 * * mon", "30 2 * * 0", "*/30 * * * * *"]) {
      expect(validateCron(ok), ok).toMatchObject({ valid: true });
    }
  });

  it("rejects wrong field counts, out-of-range values, bad ranges, unknown macros", () => {
    expect(validateCron("").valid).toBe(false);
    expect(validateCron("0 8 * *").valid).toBe(false); // 4 fields
    expect(validateCron("99 8 * * *").valid).toBe(false); // minute > 59
    expect(validateCron("0 25 * * *").valid).toBe(false); // hour > 23
    expect(validateCron("0 8 * * 9").valid).toBe(false); // dow > 7
    expect(validateCron("0 8 32 * *").valid).toBe(false); // dom > 31
    expect(validateCron("0 9-5 * * *").valid).toBe(false); // inverted range
    expect(validateCron("*/0 * * * *").valid).toBe(false); // zero step
    expect(validateCron("@weeklyish").valid).toBe(false); // unknown macro
    expect(validateCron("0 8 * * funday").valid).toBe(false); // bad name
  });

  it("reports a helpful, field-scoped error", () => {
    const res = validateCron("0 25 * * *");
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/hour/);
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and UTC", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
  it("rejects junk", () => {
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    // @ts-expect-error non-string
    expect(isValidTimeZone(null)).toBe(false);
  });
});
