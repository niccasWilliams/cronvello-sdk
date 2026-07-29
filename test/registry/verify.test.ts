import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { parseBearer, signHmacSha256, timingSafeEqual } from "../../src/registry/verify.js";

describe("parseBearer", () => {
  it("extracts the token from a well-formed header", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme and tolerates extra whitespace", () => {
    expect(parseBearer("  bearer    tok  ")).toBe("tok");
    expect(parseBearer("BEARER xyz")).toBe("xyz");
  });

  it("returns null for missing, empty, or non-bearer headers", () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("is true only for identical strings", () => {
    expect(timingSafeEqual("secret-value", "secret-value")).toBe(true);
    expect(timingSafeEqual("secret-value", "secret-walue")).toBe(false);
  });

  it("is false for length mismatches without throwing", () => {
    expect(timingSafeEqual("short", "longer-value")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  it("treats two empty strings as equal", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("handles multi-byte UTF-8 correctly", () => {
    expect(timingSafeEqual("schlüssel", "schlüssel")).toBe(true);
    expect(timingSafeEqual("schlüssel", "schlussel")).toBe(false);
  });
});

describe("signHmacSha256", () => {
  it("matches Node's reference HMAC-SHA256 in `sha256=<hex>` form", async () => {
    const payload = JSON.stringify({ runId: "r1", success: true });
    const secret = "a".repeat(32);
    const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    expect(await signHmacSha256(payload, secret)).toBe(expected);
  });

  it("produces distinct signatures for distinct secrets", async () => {
    const a = await signHmacSha256("body", "secret-one-secret-one");
    const b = await signHmacSha256("body", "secret-two-secret-two");
    expect(a).not.toBe(b);
  });
});
