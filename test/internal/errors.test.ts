import { describe, expect, it } from "vitest";
import {
  CronvelloApiError,
  CronvelloConfigError,
  CronvelloError,
  CronvelloNetworkError,
} from "../../src/internal/errors.js";

describe("error taxonomy", () => {
  it("every SDK error is a CronvelloError and a real Error", () => {
    const errs = [
      new CronvelloError("x"),
      new CronvelloApiError({ status: 500, endpoint: "GET /x", message: "m" }),
      new CronvelloNetworkError("GET /x", new Error("boom")),
      new CronvelloConfigError("bad"),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(CronvelloError);
    }
  });

  it("preserves instanceof across subclasses (prototype chain restored)", () => {
    const api = new CronvelloApiError({ status: 404, endpoint: "GET /x", message: "nope" });
    expect(api).toBeInstanceOf(CronvelloApiError);
    expect(api).not.toBeInstanceOf(CronvelloConfigError);
  });

  it("CronvelloApiError formats its message and exposes status helpers", () => {
    const e = new CronvelloApiError({ status: 429, endpoint: "POST /v1/jobs", message: "slow", code: "RATE", retryAfterSeconds: 5 });
    expect(e.message).toBe("[429] POST /v1/jobs: slow");
    expect(e.code).toBe("RATE");
    expect(e.retryAfterSeconds).toBe(5);
    expect(e.isRateLimited).toBe(true);
    expect(e.isAuthError).toBe(false);
    expect(e.isNotFound).toBe(false);
  });

  it("classifies auth and not-found statuses", () => {
    expect(new CronvelloApiError({ status: 401, endpoint: "x", message: "" }).isAuthError).toBe(true);
    expect(new CronvelloApiError({ status: 403, endpoint: "x", message: "" }).isAuthError).toBe(true);
    expect(new CronvelloApiError({ status: 404, endpoint: "x", message: "" }).isNotFound).toBe(true);
  });

  it("CronvelloNetworkError keeps the underlying cause", () => {
    const cause = new Error("ECONNRESET");
    const e = new CronvelloNetworkError("GET /v1/me", cause);
    expect(e.cause).toBe(cause);
    expect(e.message).toContain("ECONNRESET");
    expect(e.endpoint).toBe("GET /v1/me");
  });
});
