import { describe, expect, it } from "vitest";
import { CronvelloAdminClient } from "../../src/client/admin-client.js";
import { CRONVELLO_DEFAULT_BASE_URL } from "../../src/client/client.js";
import { CronvelloApiError, CronvelloConfigError } from "../../src/internal/errors.js";
import { enveloped, errorBody, mockFetch, type RecordedCall } from "../helpers/mock-fetch.js";

function admin(route: (call: RecordedCall) => unknown = () => ({})) {
  const mf = mockFetch((call) => ({ body: enveloped(route(call)) }));
  return { c: new CronvelloAdminClient({ serviceKey: "svc_test", fetch: mf.fetch }), mf };
}

function pathOf(call: RecordedCall) {
  return `${call.method} ${new URL(call.url).pathname}`;
}

/** A minimally valid register body, so each test can vary only the field under test. */
const REGISTER: Parameters<CronvelloAdminClient["externalApps"]["register"]>[0] = {
  appId: "node-shop",
  name: "Shop",
  base_url: "https://shop.example.com",
  generateApiKey: true,
};

describe("CronvelloAdminClient — construction", () => {
  it("requires a serviceKey", () => {
    // @ts-expect-error missing serviceKey
    expect(() => new CronvelloAdminClient({})).toThrow(CronvelloConfigError);
  });

  it("rejects an empty serviceKey before any network call", () => {
    expect(() => new CronvelloAdminClient({ serviceKey: "" })).toThrow(CronvelloConfigError);
  });

  it("defaults to the production base URL and strips trailing slashes", () => {
    const c = new CronvelloAdminClient({ serviceKey: "k", baseUrl: `${CRONVELLO_DEFAULT_BASE_URL}/` });
    expect(c.baseUrl).toBe(CRONVELLO_DEFAULT_BASE_URL);
  });

  it("shares the host with the account API — the operator surface is a path, not another service", () => {
    const account = new CronvelloAdminClient({ serviceKey: "k" });
    expect(account.baseUrl).toBe(CRONVELLO_DEFAULT_BASE_URL);
  });
});

describe("CronvelloAdminClient — endpoint routing", () => {
  it("maps every external-app method to the right verb+path", async () => {
    const { c, mf } = admin();
    await c.externalApps.register(REGISTER);
    await c.externalApps.status("node-shop");
    await c.externalApps.rotateKey("node-shop");
    await c.externalApps.delete(42);
    expect(mf.calls.map(pathOf)).toEqual([
      "POST /external-apps/service/register",
      "GET /external-apps/service/status/node-shop",
      "POST /external-apps/service/rotate-key/node-shop",
      "DELETE /external-apps/service/delete/42",
    ]);
  });

  it("sends the service key as a bearer token", async () => {
    const { c, mf } = admin();
    await c.externalApps.status("node-shop");
    expect(mf.lastCall().headers["authorization"]).toBe("Bearer svc_test");
  });

  it("URL-encodes appIds that contain path-significant characters", async () => {
    const { c, mf } = admin();
    await c.externalApps.status("acme/prod app");
    expect(new URL(mf.lastCall().url).pathname).toBe("/external-apps/service/status/acme%2Fprod%20app");
  });

  it("forwards the register body verbatim", async () => {
    const { c, mf } = admin();
    await c.externalApps.register({ ...REGISTER, jobRoutePath: "/cron-jobs", isActive: false });
    expect(mf.lastCall().json).toEqual({
      appId: "node-shop",
      name: "Shop",
      base_url: "https://shop.example.com",
      generateApiKey: true,
      jobRoutePath: "/cron-jobs",
      isActive: false,
    });
  });

  it("honours a custom baseUrl (self-hosted / staging)", async () => {
    const mf = mockFetch(() => ({ body: enveloped({}) }));
    const c = new CronvelloAdminClient({ serviceKey: "k", baseUrl: "https://cron.internal:8080", fetch: mf.fetch });
    await c.externalApps.status("a");
    expect(mf.lastCall().url).toBe("https://cron.internal:8080/external-apps/service/status/a");
  });
});

describe("CronvelloAdminClient — responses", () => {
  it("unwraps the success envelope and surfaces the one-time generated key", async () => {
    const { c } = admin(() => ({ id: 7, appId: "node-shop", generatedApiKey: "crn_app_secret" }));
    const app = await c.externalApps.register(REGISTER);
    expect(app.id).toBe(7);
    expect(app.generatedApiKey).toBe("crn_app_secret");
  });

  it("surfaces the one-time rotated key", async () => {
    const { c } = admin(() => ({ id: 7, appId: "node-shop", newApiKey: "crn_app_rotated" }));
    const app = await c.externalApps.rotateKey("node-shop");
    expect(app.newApiKey).toBe("crn_app_rotated");
  });

  it("reports an unregistered app without throwing", async () => {
    const { c } = admin(() => ({ registered: false, isActive: false, lastSyncedAt: null, isLive: false, jobCount: 0 }));
    const status = await c.externalApps.status("never-seen");
    expect(status.registered).toBe(false);
    expect(status.jobCount).toBe(0);
  });
});

describe("CronvelloAdminClient — error handling", () => {
  it("maps a rejected service key to CronvelloApiError with isAuthError", async () => {
    const mf = mockFetch([{ status: 403, body: errorBody("Forbidden: Invalid API Key") }]);
    const c = new CronvelloAdminClient({ serviceKey: "wrong", fetch: mf.fetch, maxRetries: 0 });
    const err = await c.externalApps.status("node-shop").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CronvelloApiError);
    expect((err as CronvelloApiError).status).toBe(403);
    expect((err as CronvelloApiError).isAuthError).toBe(true);
    expect((err as CronvelloApiError).endpoint).toBe("GET /external-apps/service/status/node-shop");
  });

  it("never falls back to a raw fetch throw", async () => {
    const mf = mockFetch([{ throw: new Error("ECONNREFUSED") }]);
    const c = new CronvelloAdminClient({ serviceKey: "k", fetch: mf.fetch, maxRetries: 0 });
    await expect(c.externalApps.status("node-shop")).rejects.toThrowError(/Network error calling/);
  });
});

describe("CronvelloAdminClient — input guards", () => {
  it("rejects a register body with neither base_url nor targetUrl", () => {
    const { c } = admin();
    expect(() => c.externalApps.register({ appId: "a", name: "A", generateApiKey: true })).toThrow(
      CronvelloConfigError,
    );
  });

  it("rejects api_key auth without a key and without generateApiKey", () => {
    const { c } = admin();
    expect(() => c.externalApps.register({ appId: "a", name: "A", base_url: "https://x" })).toThrow(
      CronvelloConfigError,
    );
  });

  it("accepts targetUrl as the alternative to base_url", async () => {
    const { c, mf } = admin();
    await c.externalApps.register({ appId: "a", name: "A", targetUrl: 3, apiKey: "k" });
    expect(mf.calls).toHaveLength(1);
  });

  it("rejects oauth auth missing either credential", () => {
    const { c } = admin();
    expect(() =>
      c.externalApps.register({ appId: "a", name: "A", base_url: "https://x", oauthClientId: "id" }),
    ).toThrow(CronvelloConfigError);
  });

  it("infers oauth from the oauth fields and accepts a complete pair", async () => {
    const { c, mf } = admin();
    await c.externalApps.register({
      appId: "a",
      name: "A",
      base_url: "https://x",
      oauthClientId: "id",
      oauthClientSecret: "secret",
    });
    expect(mf.calls).toHaveLength(1);
  });

  it("rejects a blank appId and a blank name", () => {
    const { c } = admin();
    expect(() => c.externalApps.register({ ...REGISTER, appId: "  " })).toThrow(CronvelloConfigError);
    expect(() => c.externalApps.register({ ...REGISTER, name: "" })).toThrow(CronvelloConfigError);
  });

  it("rejects a blank appId on status and rotateKey", () => {
    const { c } = admin();
    expect(() => c.externalApps.status("")).toThrow(CronvelloConfigError);
    expect(() => c.externalApps.rotateKey("   ")).toThrow(CronvelloConfigError);
  });

  it("rejects the string appId on delete — that route takes the numeric id", () => {
    const { c } = admin();
    // @ts-expect-error delete takes the numeric ExternalApp.id, not the string appId
    expect(() => c.externalApps.delete("node-shop")).toThrow(CronvelloConfigError);
    expect(() => c.externalApps.delete(0)).toThrow(CronvelloConfigError);
    expect(() => c.externalApps.delete(1.5)).toThrow(CronvelloConfigError);
  });

  it("makes no network call when a guard trips", () => {
    const { c, mf } = admin();
    expect(() => c.externalApps.status("")).toThrow(CronvelloConfigError);
    expect(mf.calls).toHaveLength(0);
  });
});
