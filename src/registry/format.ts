/**
 * Render a `ReconcileResult` as a clean, human-readable summary — for boot logs, CI output, and
 * `npx cronvello sync`. Zero-dependency ANSI colouring, opt-in via `color: true`.
 */

import type { ReconcileResult, ReconcileTaskChange } from "./types.js";

export interface FormatOptions {
  /** Emit ANSI colour codes (default false — safe for log files). */
  color?: boolean;
  /** Label the summary as a preview ("would …") rather than an applied change. */
  dryRun?: boolean;
}

const ESC = String.fromCharCode(27); // ANSI escape
const ANSI = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
} as const;

type Color = keyof typeof ANSI;

const GLYPH: Record<ReconcileTaskChange["action"], { sign: string; color: Color }> = {
  created: { sign: "+", color: "green" },
  updated: { sign: "~", color: "yellow" },
  unchanged: { sign: "=", color: "gray" },
  deleted: { sign: "-", color: "red" },
  skipped: { sign: "·", color: "cyan" },
};

/** Build the multi-line summary string. */
export function formatSyncResult(result: ReconcileResult, options: FormatOptions = {}): string {
  const paint = (s: string, c: Color) => (options.color ? `${ANSI[c]}${s}${ANSI.reset}` : s);
  const verb = options.dryRun ? "would sync" : "synced";
  const lines: string[] = [];

  lines.push(
    `${paint("Cronvello", "cyan")} ${verb} ${paint(`"${result.jobName}"`, "bold")} ${paint(`(${result.jobId})`, "gray")}`,
  );

  // Per-task lines, in a stable, readable order.
  const order: ReconcileTaskChange["action"][] = ["created", "updated", "deleted", "skipped", "unchanged"];
  const sorted = [...result.changes].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  for (const c of sorted) {
    const g = GLYPH[c.action];
    const detail =
      c.changedFields && c.changedFields.length
        ? paint(` (${c.changedFields.join(", ")})`, "gray")
        : c.reason
          ? paint(` (${c.reason})`, "gray")
          : "";
    lines.push(`  ${paint(g.sign, g.color)} ${paint(c.action.padEnd(9), g.color)} ${c.key}${detail}`);
  }

  const tally = [
    result.created && `${result.created} created`,
    result.updated && `${result.updated} updated`,
    result.unchanged && `${result.unchanged} unchanged`,
    result.deleted && `${result.deleted} deleted`,
    result.skipped && `${result.skipped} skipped`,
  ].filter(Boolean);
  const summary = tally.length ? tally.join(", ") : "no changes";
  const containerNote = result.jobCreated ? paint("  ·  container created", "gray") : "";
  lines.push(`  ${paint(summary, "bold")}${containerNote}`);

  return lines.join("\n");
}
