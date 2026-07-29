/**
 * Client-side cron + IANA-timezone validation.
 *
 * The goal is to catch *typos* at define/sync time with a clear message — not to re-implement the
 * server's scheduler. So the validator is deliberately permissive: it accepts the standard 5-field
 * crontab syntax (and an optional leading seconds field), the common `@macros`, names for months
 * and weekdays, and step/range/list combinations. Anything it cannot confidently reject is allowed
 * through, so a valid-but-unusual expression never blocks a deploy.
 */

const MACROS = new Set([
  "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly", "@reboot",
]);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  label: string;
}

// Field order for a 5-part expression.
const FIVE: FieldSpec[] = [
  { min: 0, max: 59, label: "minute" },
  { min: 0, max: 23, label: "hour" },
  { min: 1, max: 31, label: "day-of-month" },
  { min: 1, max: 12, names: MONTHS, label: "month" },
  { min: 0, max: 7, names: DOWS, label: "day-of-week" }, // 0 and 7 are both Sunday
];
const SECONDS: FieldSpec = { min: 0, max: 59, label: "second" };

export interface CronValidation {
  valid: boolean;
  /** Human-readable reason when invalid. */
  error?: string;
}

/** Validate a cron expression. Returns `{ valid, error? }` rather than throwing. */
export function validateCron(expr: string): CronValidation {
  if (typeof expr !== "string" || !expr.trim()) {
    return { valid: false, error: "schedule is empty" };
  }
  const trimmed = expr.trim();
  if (trimmed.startsWith("@")) {
    return MACROS.has(trimmed.toLowerCase())
      ? { valid: true }
      : { valid: false, error: `unknown cron macro "${trimmed}" (try @daily, @hourly, …)` };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    return {
      valid: false,
      error: `expected 5 fields (min hour dom month dow) or 6 with seconds, got ${parts.length}: "${trimmed}"`,
    };
  }

  const specs = parts.length === 6 ? [SECONDS, ...FIVE] : FIVE;
  for (let i = 0; i < parts.length; i++) {
    const err = validateField(parts[i]!, specs[i]!);
    if (err) return { valid: false, error: `invalid ${specs[i]!.label} "${parts[i]}": ${err}` };
  }
  return { valid: true };
}

function validateField(field: string, spec: FieldSpec): string | null {
  // A field is a comma-separated list of terms.
  for (const term of field.split(",")) {
    const err = validateTerm(term, spec);
    if (err) return err;
  }
  return null;
}

function validateTerm(term: string, spec: FieldSpec): string | null {
  if (term === "") return "empty list item";
  // step: <range-or-*>/<n>
  let step: string | undefined;
  let base = term;
  const slash = term.indexOf("/");
  if (slash >= 0) {
    base = term.slice(0, slash);
    step = term.slice(slash + 1);
    if (!/^\d+$/.test(step) || Number(step) === 0) return `step must be a positive integer`;
  }
  if (base === "*") return null;
  // range: a-b
  const dash = base.indexOf("-");
  if (dash > 0) {
    const lo = resolveValue(base.slice(0, dash), spec);
    const hi = resolveValue(base.slice(dash + 1), spec);
    if (lo === null) return `"${base.slice(0, dash)}" is out of range ${spec.min}-${spec.max}`;
    if (hi === null) return `"${base.slice(dash + 1)}" is out of range ${spec.min}-${spec.max}`;
    if (lo > hi) return `range start ${lo} is greater than end ${hi}`;
    return null;
  }
  // single value (only meaningful with a step if it's the base of `n/step`, which crontab rejects;
  // but most parsers accept it, so we stay permissive).
  if (step !== undefined && base !== "*") {
    // e.g. "5/10" — accept the base as a start value.
    return resolveValue(base, spec) === null ? `"${base}" is out of range ${spec.min}-${spec.max}` : null;
  }
  return resolveValue(base, spec) === null ? `"${base}" is out of range ${spec.min}-${spec.max}` : null;
}

/** Resolve a numeric or named field value to its number, or null if out of range / unknown. */
function resolveValue(token: string, spec: FieldSpec): number | null {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= spec.min && n <= spec.max ? n : null;
  }
  if (spec.names) {
    const idx = spec.names.indexOf(token.toLowerCase());
    if (idx >= 0) return idx + (spec.label === "month" ? 1 : 0);
  }
  return null;
}

/** Throw a clear error if the cron expression is invalid. `context` is woven into the message. */
export function assertValidCron(expr: string, context = ""): void {
  const res = validateCron(expr);
  if (!res.valid) {
    throw new Error(`${context ? `${context}: ` : ""}invalid cron schedule — ${res.error}`);
  }
}

/** True if `tz` is a valid IANA timezone (uses the runtime's Intl database). "UTC" always passes. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throw a clear error if the timezone is not a valid IANA zone. */
export function assertValidTimeZone(tz: string, context = ""): void {
  if (!isValidTimeZone(tz)) {
    throw new Error(`${context ? `${context}: ` : ""}invalid timezone "${tz}" (expected an IANA name like "Europe/Berlin" or "UTC")`);
  }
}
