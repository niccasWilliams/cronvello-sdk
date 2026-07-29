/**
 * Zero-dependency terminal UI helpers for the `cronvello` CLI: colour, symbols, tables, boxes,
 * relative times. Colour auto-disables when stdout is not a TTY, when NO_COLOR is set, or when
 * `--no-color` was passed (see `setColor`).
 */

const E = String.fromCharCode(27);
const ENV = typeof process !== "undefined" && process.env ? process.env : {};
let COLOR =
  !ENV["NO_COLOR"] &&
  (!!ENV["FORCE_COLOR"] || !!(typeof process !== "undefined" && process.stdout && process.stdout.isTTY));

export function setColor(on: boolean): void {
  COLOR = on;
}

function wrap(code: number, close: number, s: string): string {
  return COLOR ? `${E}[${code}m${s}${E}[${close}m` : s;
}

export const c = {
  bold: (s: string) => wrap(1, 22, s),
  dim: (s: string) => wrap(2, 22, s),
  red: (s: string) => wrap(31, 39, s),
  green: (s: string) => wrap(32, 39, s),
  yellow: (s: string) => wrap(33, 39, s),
  blue: (s: string) => wrap(34, 39, s),
  magenta: (s: string) => wrap(35, 39, s),
  cyan: (s: string) => wrap(36, 39, s),
  gray: (s: string) => wrap(90, 39, s),
};

/** Cronvello brand: indigo-ish on supported terminals (256-colour), falling back to cyan. */
export function brand(s: string): string {
  return COLOR ? `${E}[38;5;63m${s}${E}[39m` : s;
}

export const sym = {
  ok: c.green("✔"),
  fail: c.red("✗"),
  warn: c.yellow("▲"),
  info: c.cyan("ℹ"),
  dot: c.gray("·"),
  arrow: c.gray("→"),
};

/** Visible length of a string, ignoring ANSI escape codes — for column alignment. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padEndVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export interface TableColumn {
  header: string;
  /** Right-align (e.g. numbers). */
  align?: "left" | "right";
}

/** Render an aligned table. Cells may already contain colour codes. */
export function table(columns: TableColumn[], rows: string[][]): string {
  const widths = columns.map((col, i) =>
    Math.max(visibleLength(col.header), ...rows.map((r) => visibleLength(r[i] ?? ""))),
  );
  const fmtRow = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const w = widths[i]!;
        if (columns[i]?.align === "right") {
          const pad = w - visibleLength(cell);
          return (pad > 0 ? " ".repeat(pad) : "") + cell;
        }
        return padEndVisible(cell, w);
      })
      .join("  ");
  const head = fmtRow(columns.map((col) => c.dim(col.header)));
  const body = rows.map(fmtRow);
  return [head, ...body].join("\n");
}

/** A simple rounded box around a block of text (already-coloured lines are fine). */
export function box(title: string, lines: string[]): string {
  const inner = [title, "", ...lines];
  const width = Math.max(...inner.map(visibleLength));
  const top = c.gray("╭─ ") + brand(title) + c.gray(" " + "─".repeat(Math.max(0, width - visibleLength(title) - 1)) + "╮");
  const mid = lines.map((l) => c.gray("│ ") + padEndVisible(l, width) + c.gray(" │"));
  const bot = c.gray("╰" + "─".repeat(width + 2) + "╯");
  return [top, ...mid, bot].join("\n");
}

/** Compact relative time like "3m ago" / "in 2h" from an ISO string. `nowMs` is injectable for tests. */
export function relativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return c.gray("—");
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return c.gray("—");
  const deltaSec = Math.round((then - nowMs) / 1000);
  const future = deltaSec > 0;
  const abs = Math.abs(deltaSec);
  const unit =
    abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return c.gray(future ? `in ${unit}` : `${unit} ago`);
}

export const ICON = brand("◷"); // clock-ish brand mark for the header
