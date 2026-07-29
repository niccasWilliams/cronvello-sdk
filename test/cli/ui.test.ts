import { describe, expect, it, beforeEach } from "vitest";
import { c, setColor, table, box, relativeTime, visibleLength } from "../../src/cli/ui.js";

describe("cli/ui — colour toggling", () => {
  beforeEach(() => setColor(true));

  it("wraps in ANSI when colour is on and strips when off", () => {
    setColor(true);
    expect(c.green("ok")).toContain("\x1b[");
    setColor(false);
    expect(c.green("ok")).toBe("ok");
  });
});

describe("cli/ui — visibleLength ignores ANSI", () => {
  it("counts only printable characters", () => {
    setColor(true);
    expect(visibleLength(c.red("abc"))).toBe(3);
    setColor(false);
    expect(visibleLength("abc")).toBe(3);
  });
});

describe("cli/ui — table", () => {
  beforeEach(() => setColor(false));

  it("aligns columns and right-aligns numeric columns", () => {
    const t = table(
      [{ header: "NAME" }, { header: "N", align: "right" }],
      [["alpha", "1"], ["b", "200"]],
    );
    const lines = t.split("\n");
    expect(lines[0]).toContain("NAME");
    // The single-char name is padded to the width of "alpha" (5) + 2-space gutter, then "200".
    expect(lines[1]).toMatch(/^alpha {2}  1$/); // "200" width 3 → "1" right-aligned to 3
    expect(lines[2]).toMatch(/^b {6}200$/);
  });
});

describe("cli/ui — box", () => {
  it("draws a bordered block containing the lines", () => {
    setColor(false);
    const b = box("Title", ["line one", "line two"]);
    expect(b).toContain("Title");
    expect(b).toContain("line one");
    expect(b.split("\n").length).toBeGreaterThanOrEqual(4);
  });
});

describe("cli/ui — relativeTime", () => {
  beforeEach(() => setColor(false));
  const now = Date.parse("2026-06-24T12:00:00.000Z");

  it("formats past and future deltas compactly", () => {
    expect(relativeTime("2026-06-24T11:59:30.000Z", now)).toBe("30s ago");
    expect(relativeTime("2026-06-24T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-06-24T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-06-26T12:00:00.000Z", now)).toBe("in 2d");
  });

  it("renders an em dash for null or unparseable input", () => {
    expect(relativeTime(null, now)).toBe("—");
    expect(relativeTime("not-a-date", now)).toBe("—");
  });
});
