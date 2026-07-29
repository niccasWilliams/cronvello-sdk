/**
 * Cron schedule arithmetic for the local engine — next-occurrence, preview, and an upcoming-window
 * planner, all timezone-aware (IANA / DST) and **zero-dependency**.
 *
 * The cloud SDK only needs to *validate* a cron string (see `cron.ts`), because the server owns the
 * scheduler. The local engine has to actually *fire* jobs, so it needs the next time an expression
 * matches. This module is that calculator.
 *
 * How the timezone math works without a date library:
 *   • A cron expression matches against **wall-clock** fields (the time a person reads off a clock in
 *     the job's timezone), so the search is done on naive calendar fields and only converted to a
 *     real epoch once a full match is found.
 *   • To convert a wall-clock time in a zone to an absolute epoch we use the runtime's own IANA
 *     database via `Intl.DateTimeFormat`: format a guess into the zone, measure the offset it
 *     implies, and correct once. This is the standard offset-probe technique and it handles DST
 *     transitions (a daily job at 04:00 stays at 04:00 local; the gap to the previous fire is 23h or
 *     25h across the spring/autumn switch).
 *
 * Supported syntax mirrors `validateCron`: 5-field crontab, an optional leading seconds field
 * (6 fields), the `@macros`, month/weekday names, and `*` / ranges / lists / steps. Day-of-month and
 * day-of-week combine with Vixie cron's OR semantics when both are restricted.
 */

const MACRO_EXPANSIONS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a resolved name index (months are 1-based, weekdays 0-based). */
  nameOffset: number;
  /** Map an expanded value into its canonical form (used to fold weekday 7 → 0). */
  fold?: (v: number) => number;
  label: string;
}

const SECOND_SPEC: FieldSpec = { min: 0, max: 59, nameOffset: 0, label: "second" };
const MINUTE_SPEC: FieldSpec = { min: 0, max: 59, nameOffset: 0, label: "minute" };
const HOUR_SPEC: FieldSpec = { min: 0, max: 23, nameOffset: 0, label: "hour" };
const DOM_SPEC: FieldSpec = { min: 1, max: 31, nameOffset: 0, label: "day-of-month" };
const MONTH_SPEC: FieldSpec = { min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1, label: "month" };
const DOW_SPEC: FieldSpec = { min: 0, max: 7, names: DOW_NAMES, nameOffset: 0, fold: (v) => v % 7, label: "day-of-week" };

/** A cron expression compiled into the set of values each field matches. */
export interface ParsedCron {
  /** Allowed seconds. For a 5-field expression this is `{0}`. */
  seconds: Set<number>;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  /** Allowed weekdays, 0 = Sunday … 6 = Saturday (7 is folded to 0). */
  daysOfWeek: Set<number>;
  /** True when the day-of-month field was anything other than `*`/`?`. */
  domRestricted: boolean;
  /** True when the day-of-week field was anything other than `*`/`?`. */
  dowRestricted: boolean;
  /** True for `@reboot`, which has no scheduled next time (the engine fires it once at start). */
  reboot: boolean;
}

/** Parse a cron expression into matchable value-sets. Throws on a malformed expression. */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== "string" || !expr.trim()) throw new Error("cron expression is empty");
  let trimmed = expr.trim();

  if (trimmed.startsWith("@")) {
    const macro = trimmed.toLowerCase();
    if (macro === "@reboot") {
      return {
        seconds: new Set([0]), minutes: new Set(), hours: new Set(), daysOfMonth: new Set(),
        months: new Set(), daysOfWeek: new Set(), domRestricted: false, dowRestricted: false, reboot: true,
      };
    }
    const expanded = MACRO_EXPANSIONS[macro];
    if (!expanded) throw new Error(`unknown cron macro "${trimmed}" (try @daily, @hourly, …)`);
    trimmed = expanded;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(`expected 5 fields (min hour dom month dow) or 6 with seconds, got ${parts.length}: "${trimmed}"`);
  }

  const hasSeconds = parts.length === 6;
  const [secRaw, minRaw, hourRaw, domRaw, monthRaw, dowRaw] = hasSeconds
    ? parts
    : ["0", ...parts];

  return {
    seconds: expandField(secRaw!, SECOND_SPEC),
    minutes: expandField(minRaw!, MINUTE_SPEC),
    hours: expandField(hourRaw!, HOUR_SPEC),
    daysOfMonth: expandField(domRaw!, DOM_SPEC),
    months: expandField(monthRaw!, MONTH_SPEC),
    daysOfWeek: expandField(dowRaw!, DOW_SPEC),
    domRestricted: isRestricted(domRaw!),
    dowRestricted: isRestricted(dowRaw!),
    reboot: false,
  };
}

function isRestricted(field: string): boolean {
  const f = field.trim();
  return f !== "*" && f !== "?";
}

/** Expand one comma-separated field (`*`, ranges, lists, steps, names) into its value set. */
function expandField(raw: string, spec: FieldSpec): Set<number> {
  const set = new Set<number>();
  for (const term of raw.split(",")) {
    if (term === "") throw new Error(`empty term in ${spec.label} field "${raw}"`);

    let base = term;
    let step = 1;
    const slash = term.indexOf("/");
    if (slash >= 0) {
      base = term.slice(0, slash);
      const stepStr = term.slice(slash + 1);
      if (!/^\d+$/.test(stepStr) || Number(stepStr) === 0) {
        throw new Error(`invalid step "${stepStr}" in ${spec.label} field "${raw}"`);
      }
      step = Number(stepStr);
    }

    let lo: number | null;
    let hi: number | null;
    if (base === "*" || base === "?") {
      lo = spec.min;
      hi = spec.max;
    } else {
      const dash = base.indexOf("-");
      if (dash > 0) {
        lo = resolveValue(base.slice(0, dash), spec);
        hi = resolveValue(base.slice(dash + 1), spec);
      } else {
        lo = resolveValue(base, spec);
        // A bare value with a step (e.g. "5/15") runs from the value up to the field max.
        hi = step > 1 ? spec.max : lo;
      }
    }

    if (lo === null || hi === null) {
      throw new Error(`value out of range in ${spec.label} field "${raw}" (${spec.min}-${spec.max})`);
    }
    if (lo > hi) throw new Error(`range start ${lo} is greater than end ${hi} in ${spec.label} field "${raw}"`);

    for (let v = lo; v <= hi; v += step) set.add(spec.fold ? spec.fold(v) : v);
  }
  return set;
}

/** Resolve a numeric or named token to its number, or null when out of range / unknown. */
function resolveValue(token: string, spec: FieldSpec): number | null {
  const t = token.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= spec.min && n <= spec.max ? n : null;
  }
  if (spec.names) {
    const idx = spec.names.indexOf(t.toLowerCase());
    if (idx >= 0) return idx + spec.nameOffset;
  }
  return null;
}

// ─── Next-occurrence search ──────────────────────────────────────────────────

export interface NextOccurrenceOptions {
  /** Search strictly after this instant (epoch ms or Date). Defaults to now. */
  from?: Date | number;
  /** IANA timezone the expression is read in. Defaults to "UTC". */
  timeZone?: string;
}

/** How many years ahead the search gives up after — a guard against impossible expressions. */
const SEARCH_HORIZON_YEARS = 5;

/**
 * The next instant the expression fires, strictly after `from`, in the given timezone — or `null`
 * when nothing matches within {@link SEARCH_HORIZON_YEARS} (e.g. Feb-30). Throws for `@reboot`.
 */
export function nextOccurrence(expr: string | ParsedCron, opts: NextOccurrenceOptions = {}): Date | null {
  const parsed = typeof expr === "string" ? parseCron(expr) : expr;
  if (parsed.reboot) throw new Error("@reboot has no scheduled next occurrence (the engine fires it once at start)");

  const tz = opts.timeZone ?? "UTC";
  const fromMs = opts.from === undefined ? Date.now() : typeof opts.from === "number" ? opts.from : opts.from.getTime();

  // Move strictly forward by at least one whole second, then search on wall-clock fields.
  const cursor = Math.floor(fromMs / 1000) * 1000 + 1000;
  const p = getZonedParts(cursor, tz);
  const startYear = p.y;

  const hourArr = sorted(parsed.hours);
  const minuteArr = sorted(parsed.minutes);
  const secondArr = sorted(parsed.seconds);

  let guard = 0;
  while (guard++ < 1_000_000) {
    if (p.y > startYear + SEARCH_HORIZON_YEARS) return null;

    if (!parsed.months.has(p.mo)) {
      bumpMonth(p);
      continue;
    }
    if (p.d > daysInMonth(p.y, p.mo)) {
      bumpMonth(p);
      continue;
    }
    if (!dayMatches(parsed, p.y, p.mo, p.d)) {
      bumpDay(p);
      continue;
    }
    const nh = firstAtLeast(hourArr, p.h);
    if (nh === null) {
      bumpDay(p);
      continue;
    }
    if (nh !== p.h) {
      p.h = nh;
      p.mi = 0;
      p.s = 0;
    }
    const nmi = firstAtLeast(minuteArr, p.mi);
    if (nmi === null) {
      p.h += 1;
      p.mi = 0;
      p.s = 0;
      continue;
    }
    if (nmi !== p.mi) {
      p.mi = nmi;
      p.s = 0;
    }
    const ns = firstAtLeast(secondArr, p.s);
    if (ns === null) {
      p.mi += 1;
      p.s = 0;
      continue;
    }
    p.s = ns;

    // Full wall-clock match — convert to a real epoch in the zone.
    const epoch = zonedWallToEpoch(p, tz);
    // Guard against a DST fold mapping the candidate back to or before `from`.
    if (epoch <= fromMs) {
      p.s += 1;
      continue;
    }
    return new Date(epoch);
  }
  throw new Error(`nextOccurrence: search exceeded its iteration bound for "${typeof expr === "string" ? expr : "(parsed)"}"`);
}

/** Whether a day satisfies the day-of-month / day-of-week fields, with Vixie OR semantics. */
function dayMatches(parsed: ParsedCron, y: number, mo: number, d: number): boolean {
  const domOk = parsed.daysOfMonth.has(d);
  const dowOk = parsed.daysOfWeek.has(weekdayOf(y, mo, d));
  if (parsed.domRestricted && parsed.dowRestricted) return domOk || dowOk;
  if (parsed.domRestricted) return domOk;
  if (parsed.dowRestricted) return dowOk;
  return true;
}

interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function bumpMonth(p: WallParts): void {
  p.mo += 1;
  if (p.mo > 12) {
    p.mo = 1;
    p.y += 1;
  }
  p.d = 1;
  p.h = 0;
  p.mi = 0;
  p.s = 0;
}

function bumpDay(p: WallParts): void {
  p.d += 1;
  p.h = 0;
  p.mi = 0;
  p.s = 0;
}

function sorted(set: Set<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

/** Smallest array element ≥ `v` (array is sorted ascending), or null. */
function firstAtLeast(arr: number[], v: number): number | null {
  for (const x of arr) if (x >= v) return x;
  return null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// ─── Timezone conversion (Intl-based, zero-dependency) ───────────────────────

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock calendar fields a clock in `timeZone` shows at the given epoch. */
function getZonedParts(epochMs: number, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const m: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") m[part.type] = part.value;
  let h = Number(m["hour"]);
  if (h === 24) h = 0; // some runtimes render midnight as "24" under hour12:false
  return { y: Number(m["year"]), mo: Number(m["month"]), d: Number(m["day"]), h, mi: Number(m["minute"]), s: Number(m["second"]) };
}

/** Offset (ms) the zone is ahead of UTC at the given instant. */
function offsetAt(epochMs: number, timeZone: string): number {
  const p = getZonedParts(epochMs, timeZone);
  const asNaive = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asNaive - epochMs;
}

/** Convert wall-clock fields in `timeZone` to an absolute epoch, correcting for the zone's offset. */
function zonedWallToEpoch(p: WallParts, timeZone: string): number {
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const o1 = offsetAt(asUTC, timeZone);
  let epoch = asUTC - o1;
  const o2 = offsetAt(epoch, timeZone);
  if (o2 !== o1) epoch = asUTC - o2;
  return epoch;
}

// ─── Preview & upcoming-window planning ──────────────────────────────────────

export interface PreviewOptions {
  /** Start the preview after this instant. Defaults to now. */
  from?: Date | number;
  /** IANA timezone. Defaults to the runtime's local zone. */
  timeZone?: string;
  /** How many fire times to return (default 5, capped at 100). */
  count?: number;
}

/** The next N times an expression fires — the engine of `cronvello preview`. */
export function previewSchedule(expr: string, opts: PreviewOptions = {}): Date[] {
  const parsed = parseCron(expr);
  const timeZone = opts.timeZone ?? localTimeZone();
  const count = Math.min(Math.max(Math.trunc(opts.count ?? 5), 1), 100);
  const out: Date[] = [];
  let from = opts.from === undefined ? Date.now() : typeof opts.from === "number" ? opts.from : opts.from.getTime();
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence(parsed, { from, timeZone });
    if (!next) break;
    out.push(next);
    from = next.getTime();
  }
  return out;
}

export interface UpcomingJob {
  key: string;
  schedule: string;
  timeZone: string;
}

export interface UpcomingFire {
  key: string;
  time: Date;
  schedule: string;
  timeZone: string;
}

export interface UpcomingOptions {
  /** Window start (defaults to now). */
  from?: Date | number;
  /** Window length in ms (defaults to 1 hour). */
  withinMs?: number;
  /** Cap per job so a per-second schedule can't flood the plan (default 50). */
  maxPerJob?: number;
}

/**
 * Every fire across a set of jobs within the next window, merged and sorted by time — what powers
 * `cronvello dev --dry-run`. Jobs whose schedule can't be parsed are skipped (a dev concern surfaced
 * elsewhere); `@reboot` jobs are skipped because they have no scheduled time.
 */
export function upcomingFires(jobs: UpcomingJob[], opts: UpcomingOptions = {}): UpcomingFire[] {
  const from = opts.from === undefined ? Date.now() : typeof opts.from === "number" ? opts.from : opts.from.getTime();
  const withinMs = opts.withinMs ?? 60 * 60 * 1000;
  const maxPerJob = Math.max(1, opts.maxPerJob ?? 50);
  const horizon = from + withinMs;

  const fires: UpcomingFire[] = [];
  for (const job of jobs) {
    let parsed: ParsedCron;
    try {
      parsed = parseCron(job.schedule);
    } catch {
      continue;
    }
    if (parsed.reboot) continue;
    let cursor = from;
    for (let i = 0; i < maxPerJob; i++) {
      const next = nextOccurrence(parsed, { from: cursor, timeZone: job.timeZone });
      if (!next || next.getTime() > horizon) break;
      fires.push({ key: job.key, time: next, schedule: job.schedule, timeZone: job.timeZone });
      cursor = next.getTime();
    }
  }
  fires.sort((a, b) => a.time.getTime() - b.time.getTime());
  return fires;
}

/** The runtime's local IANA zone, falling back to UTC if it can't be resolved. */
export function localTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
