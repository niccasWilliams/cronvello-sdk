/**
 * Human-friendly schedule builders. Each returns a plain cron string (so it drops straight into a
 * job's `schedule`), validated on the way out — a bad argument throws immediately with a clear
 * message instead of silently producing a wrong schedule.
 *
 *   import { every, daily, weekly, hourly, cron } from "@cronvello/sdk";
 *
 *   jobs: {
 *     "digest":  { schedule: daily("08:00"),        handler },
 *     "poll":    { schedule: every("15m"),          handler },
 *     "report":  { schedule: weekly("mon", "09:00"),handler },
 *     "beat":    { schedule: hourly(),              handler },
 *     "custom":  { schedule: cron("0 0 1 * *"),     handler },
 *   }
 */

import { assertValidCron } from "../internal/cron.js";

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | 0 | 1 | 2 | 3 | 4 | 5 | 6;

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Validate a raw cron expression and return it unchanged. The explicit escape hatch. */
export function cron(expression: string): string {
  assertValidCron(expression, "cron()");
  return expression;
}

/**
 * A recurring interval expressed as `<n><unit>` where unit is `s`, `m`, `h`, or `d`.
 *   every("30s") → every 30 seconds   every("15m") → every 15 minutes
 *   every("2h")  → every 2 hours      every("1d")  → daily at midnight
 * Note: sub-hour intervals that don't divide evenly (e.g. 7m) restart each hour, matching cron.
 */
export function every(interval: string): string {
  const m = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hour|hours|d|day|days)$/i.exec(interval.trim());
  if (!m) throw new Error(`every(): cannot parse interval "${interval}" — use forms like "30s", "15m", "2h", "1d"`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase()[0]; // s | m | h | d
  if (n < 1) throw new Error(`every(): interval must be at least 1, got ${n}`);

  let expr: string;
  if (unit === "s") {
    if (n > 59) throw new Error(`every(): seconds must be 1–59, got ${n}`);
    expr = `*/${n} * * * * *`; // 6-field (seconds)
  } else if (unit === "m") {
    if (n > 59) throw new Error(`every(): minutes must be 1–59 (use "1h" for 60), got ${n}`);
    expr = `*/${n} * * * *`;
  } else if (unit === "h") {
    if (n > 23) throw new Error(`every(): hours must be 1–23 (use "1d" for 24), got ${n}`);
    expr = `0 */${n} * * *`;
  } else {
    if (n > 31) throw new Error(`every(): days must be 1–31, got ${n}`);
    expr = n === 1 ? `0 0 * * *` : `0 0 */${n} * *`;
  }
  assertValidCron(expr, `every("${interval}")`);
  return expr;
}

/** Every N minutes (1–59). */
export function everyMinutes(n: number): string {
  return every(`${n}m`);
}

/** Every N hours (1–23). */
export function everyHours(n: number): string {
  return every(`${n}h`);
}

/** Once an hour, at the given minute past (default :00). */
export function hourly(minute = 0): string {
  const mm = field(minute, 0, 59, "minute");
  return cron(`${mm} * * * *`);
}

/** Once a day at "HH:MM" (24h, default midnight). */
export function daily(time = "00:00"): string {
  const { hh, mm } = parseTime(time);
  return cron(`${mm} ${hh} * * *`);
}

/** Once a week on `day` at "HH:MM". */
export function weekly(day: Weekday, time = "00:00"): string {
  const { hh, mm } = parseTime(time);
  return cron(`${mm} ${hh} * * ${weekday(day)}`);
}

/** Once a month on `dayOfMonth` (1–31) at "HH:MM". */
export function monthly(dayOfMonth: number, time = "00:00"): string {
  const { hh, mm } = parseTime(time);
  const dom = field(dayOfMonth, 1, 31, "day-of-month");
  return cron(`${mm} ${hh} ${dom} * *`);
}

/** Monday–Friday at "HH:MM". */
export function weekdays(time = "00:00"): string {
  const { hh, mm } = parseTime(time);
  return cron(`${mm} ${hh} * * 1-5`);
}

/** Saturday & Sunday at "HH:MM". */
export function weekends(time = "00:00"): string {
  const { hh, mm } = parseTime(time);
  return cron(`${mm} ${hh} * * 0,6`);
}

/** Namespace form for discoverability: `import { schedule } from "@cronvello/sdk"`. */
export const schedule = {
  cron, every, everyMinutes, everyHours, hourly, daily, weekly, monthly, weekdays, weekends,
};

function parseTime(time: string): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`Expected a time like "08:00" or "23:30", got "${time}"`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23) throw new Error(`Hour must be 0–23, got ${hh}`);
  if (mm > 59) throw new Error(`Minute must be 0–59, got ${mm}`);
  return { hh, mm };
}

function weekday(day: Weekday): number {
  if (typeof day === "number") {
    if (day < 0 || day > 6) throw new Error(`Weekday number must be 0 (Sun) – 6 (Sat), got ${day}`);
    return day;
  }
  const n = DOW[day.toLowerCase()];
  if (n === undefined) throw new Error(`Unknown weekday "${day}" — use sun…sat or 0…6`);
  return n;
}

function field(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer ${min}–${max}, got ${value}`);
  }
  return value;
}
