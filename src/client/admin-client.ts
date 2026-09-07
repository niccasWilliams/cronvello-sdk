/**
 * Operator-side client for Cronvello's backend-to-backend API (`/external-apps/service/*`).
 *
 * ## Why this is a separate class from {@link CronvelloClient}
 *
 * Both surfaces live on the same host and share the same transport, `{ success, message, data }`
 * envelope and `Authorization: Bearer` scheme — but they take **different credentials**:
 *
 * | Surface                    | Credential                          | Scope                       |
 * | -------------------------- | ----------------------------------- | --------------------------- |
 * | `/v1/*`                    | per-account API key (`crn_live_…`)  | one account's jobs and runs |
 * | `/external-apps/service/*` | Cronvello's service key             | every registered app        |
 *
 * The service key is far broader than an account key. Folding both into one object would make it
 * easy to send the wrong one — or to leak the service key onto an account-scoped call. Keeping
 * them in two objects, with two differently named options (`apiKey` vs `serviceKey`), makes that
 * mistake impossible to express.
 *
 * Nothing here is needed to *use* Cronvello. It is for the service that provisions apps into it.
 */

import { Transport, type FetchLike } from "../internal/http.js";
import { CronvelloConfigError } from "../internal/errors.js";
import { CRONVELLO_DEFAULT_BASE_URL } from "./client.js";
import type {
  ExternalAppApiKeyList,
  ExternalAppBindApiKeyInput,
  ExternalAppBoundApiKey,
  ExternalAppIssueApiKeyInput,
  ExternalAppIssuedApiKey,
  ExternalAppRegisterInput,
  ExternalAppRegisterResult,
  ExternalAppRegistrationList,
  ExternalAppRevokeKeyInput,
  ExternalAppRevokeKeyResult,
  ExternalAppRollbackKeyResult,
  ExternalAppRotateKeyInput,
  ExternalAppRotateKeyResult,
  ExternalAppStatus,
} from "../internal/admin-wire.js";

export interface CronvelloAdminClientOptions {
  /**
   * Cronvello's backend-to-backend service key. Required.
   *
   * This is **not** an account API key — it authorizes operations across every registered app.
   * Keep it server-side only.
   */
  serviceKey: string;
  /** API base URL. Defaults to https://api.cronvello.com. */
  baseUrl?: string;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Retry attempts for 429/5xx/network errors (default 2). */
  maxRetries?: number;
  /** Custom fetch implementation (default: global fetch). */
  fetch?: FetchLike;
  /** Telemetry hook for every request attempt. */
  onRequest?: (info: { method: string; path: string; status: number; attempt: number; durationMs: number }) => void;
}

/**
 * Operator access to Cronvello's app registry.
 *
 * ```ts
 * const admin = new CronvelloAdminClient({ serviceKey: process.env.CRONVELLO_SERVICE_KEY! });
 * const app = await admin.externalApps.register({
 *   appId: "node-shop",
 *   name: "Shop",
 *   base_url: "https://shop.example.com",
 *   generateApiKey: true,
 * });
 * // app.generatedApiKey is plaintext and shown exactly once.
 * ```
 *
 * Errors follow the rest of the SDK: `CronvelloConfigError` for anything caught before the
 * request leaves, `CronvelloApiError` for a non-2xx response, `CronvelloNetworkError` for a
 * transport failure.
 */
export class CronvelloAdminClient {
  private readonly transport: Transport;
  /** The resolved base URL in use. */
  readonly baseUrl: string;

  /** Registration, status, key rotation and removal of external apps. */
  readonly externalApps: ExternalAppsResource;

  constructor(options: CronvelloAdminClientOptions) {
    if (!options || !options.serviceKey) {
      throw new CronvelloConfigError(
        "CronvelloAdminClient requires a `serviceKey` (Cronvello's backend-to-backend key, not an account apiKey).",
      );
    }
    this.baseUrl = (options.baseUrl ?? CRONVELLO_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = new Transport({
      baseUrl: this.baseUrl,
      apiKey: options.serviceKey,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.onRequest ? { onRequest: options.onRequest } : {}),
    });
    this.externalApps = new ExternalAppsResource(this.transport);
  }
}

/**
 * Der Werkzeugkasten des Verwalters, als Klasse und nicht als Objektliteral — damit
 * {@link cronvelloCapabilities} die Methodenliste vom Prototyp lesen kann statt aus einer
 * gepflegten Aufzaehlung. Eine Aufzaehlung veraltet still; ein Prototyp nicht.
 */
export class ExternalAppsResource {
  constructor(private readonly t: Transport) {}

  /**
   * Idempotent upsert, keyed on the string `appId`: creates when unknown, updates credentials
   * and URL when it already exists. Safe to retry and to re-run on every provisioning pass.
   *
   * When the server mints the token (`generateApiKey: true` on a *new* app) it comes back as
   * `generatedApiKey` — plaintext, exactly once. On an update it is `null`.
   */
  register(input: ExternalAppRegisterInput): Promise<ExternalAppRegisterResult> {
    assertRegisterInput(input);
    return this.t.request({ method: "POST", path: "/external-apps/service/register", body: input });
  }

  /**
   * Every registration this Cronvello instance holds, each with its numeric `registrationId`.
   *
   * ⭐ The method the other four could not replace: they all answer about an app you already
   * name, so a caller's picture of Cronvello was only ever as complete as its own bookkeeping.
   * One operator held 3 of 8 registrations and had no way to notice — a registration it had
   * never written down looked exactly like one that did not exist. This is the read that turns
   * that assumption into a comparison.
   *
   * Credential values are never returned, only their state — same rule as {@link status}.
   *
   * Requires a Cronvello server from 2026-09-07 or later; an older one answers 404, surfacing
   * as a `CronvelloApiError` with `isNotFound`.
   */
  list(): Promise<ExternalAppRegistrationList> {
    return this.t.request({ method: "GET", path: "/external-apps/service/registrations" });
  }

  /**
   * Registration status, last-sync info and job count for one app, by its string `appId`.
   *
   * ⚠ `appId` is a caller-chosen label, and a label can be renamed. If you stored the numeric
   * id from `register()`, prefer {@link statusByRegistrationId} — this method cannot tell a
   * renamed app apart from a deleted one, and answers `registered: false` for both.
   */
  status(appId: string): Promise<ExternalAppStatus> {
    assertAppId(appId, "status");
    return this.t.request({ method: "GET", path: `/external-apps/service/status/${enc(appId)}` });
  }

  /**
   * The same status, addressed by the numeric {@link ExternalApp.id} that `register()` returned.
   *
   * Both methods name the same row; only this one survives a rename. When one operator renamed
   * an app from `williams` to `orvello`, {@link status} stopped finding it and reported "not
   * registered" for a connection that was delivering jobs the whole time — the edge sat red for
   * days with nothing actually wrong with it.
   *
   * Read `appId` off the result to repair your own copy of the label when it has gone stale.
   *
   * Requires a Cronvello server from 2026-09-06 or later. An older one has no such route and
   * answers 404, which surfaces as a `CronvelloApiError` with `isNotFound` — distinct from a
   * present route reporting an unknown id, which is a 200 with `registered: false`.
   */
  statusByRegistrationId(id: number): Promise<ExternalAppStatus> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new CronvelloConfigError(
        `externalApps.statusByRegistrationId() takes the numeric app id (ExternalApp.id), not the string appId — received ${JSON.stringify(id)}.`,
      );
    }
    return this.t.request({ method: "GET", path: `/external-apps/service/status-by-registration/${id}` });
  }

  /**
   * Mint a fresh per-app token, by string `appId`. The new token is returned once as `newApiKey`
   * and must be written into the app's environment.
   *
   * The token it replaces is kept restorable until `previousApiKeyExpiresAt` (server default:
   * 2 hours) — see {@link rollbackKey}. Before that grace period existed, rotation was a hard
   * cut: the replaced value was gone the moment the call returned, so a rollout that did not
   * land left the edge dead with no way back. Pass `gracePeriodHours: 0` to get that behaviour
   * deliberately.
   *
   * Use this for drift recovery when the current token is no longer known. A rotation also
   * clears a previous revocation — a fresh credential means the cause was addressed.
   *
   * `gracePeriodHours` requires a Cronvello server from 2026-09-07 or later; an older one
   * ignores the body and rotates hard.
   */
  rotateKey(appId: string, input: ExternalAppRotateKeyInput = {}): Promise<ExternalAppRotateKeyResult> {
    assertAppId(appId, "rotateKey");
    return this.t.request({
      method: "POST",
      path: `/external-apps/service/rotate-key/${enc(appId)}`,
      body: input,
    });
  }

  /**
   * Put the token that the last rotation replaced back in force, while its grace period runs.
   *
   * The case this exists for is ordinary: you rotated, and the new value never reached the
   * other side — a hanging deploy, an env that was not written, a rollout that broke off
   * halfway. Without a way back the only option is to chase the rollout while the edge lies
   * dead.
   *
   * Rejects with a 409 when there is nothing to restore or the grace period has ended: an
   * expired credential is a dead record, and putting it back in use would be the opposite of
   * rotating. Rotate again instead.
   *
   * Requires a Cronvello server from 2026-09-07 or later.
   */
  rollbackKey(appId: string): Promise<ExternalAppRollbackKeyResult> {
    assertAppId(appId, "rollbackKey");
    return this.t.request({ method: "POST", path: `/external-apps/service/rollback-key/${enc(appId)}` });
  }

  /**
   * Withdraw the app's credential and leave the registration standing.
   *
   * ⚠ This is the method {@link delete} is **not**. Deleting cascades onto jobs and tasks, so
   * "withdraw the key" and "end the relationship" could not be told apart, and a caller who
   * only wanted the first did nothing at all — which is how compromised credentials stay
   * valid. This takes the token out of the row, out of the grace period and out of every task
   * that still carries it, and leaves the registration, its jobs and its history where they are.
   *
   * The status then reports `liveness.state = "revoked"` with the reason. The way back is
   * {@link register} or {@link rotateKey} with a fresh credential.
   *
   * Requires a Cronvello server from 2026-09-07 or later.
   */
  revokeKey(appId: string, input: ExternalAppRevokeKeyInput = {}): Promise<ExternalAppRevokeKeyResult> {
    assertAppId(appId, "revokeKey");
    return this.t.request({
      method: "POST",
      path: `/external-apps/service/revoke-key/${enc(appId)}`,
      body: input,
    });
  }

  /**
   * The /v1 keys anchored to this registration — and therefore whether its job containers
   * can be booked at all.
   *
   * ⭐ Why this matters: `/v1` is account-authenticated, and one account holds many
   * registrations. A container created with a purely account-wide key lands without an
   * anchor, so the registration reports `jobCount: 0` and an empty `delivery` while the app
   * runs dozens of tasks — indistinguishable from a dead registration. An empty list here
   * is exactly that situation, stated before it becomes a false outage.
   *
   * Values are never returned, only state and last use.
   *
   * Requires a Cronvello server from 2026-09-07 or later.
   */
  listApiKeys(registrationId: number): Promise<ExternalAppApiKeyList> {
    assertRegistrationId(registrationId, "listApiKeys");
    return this.t.request({ method: "GET", path: `/external-apps/service/api-keys/${registrationId}` });
  }

  /**
   * Mint a /v1 key bound to this registration. The value is returned **once**.
   *
   * The way forward for every newly connected app: instead of an account-wide key it gets
   * its own, and every container it creates via `sync()` is booked from the first second —
   * there is nothing to backfill later.
   *
   * Rejects with 409 when the registration carries no account; a /v1 key is issued within one.
   *
   * Requires a Cronvello server from 2026-09-07 or later.
   */
  issueApiKey(registrationId: number, input: ExternalAppIssueApiKeyInput): Promise<ExternalAppIssuedApiKey> {
    assertRegistrationId(registrationId, "issueApiKey");
    return this.t.request({
      method: "POST",
      path: `/external-apps/service/api-keys/${registrationId}/issue`,
      body: input,
    });
  }

  /**
   * Anchor an **existing** account key to this registration.
   *
   * The way for an existing estate. Keys already in the field are usually app keys in
   * everything but the binding — they are literally named after their app. Binding gives
   * them their anchor without any app receiving a new value: no deploy, no swap, no window
   * in which something is half migrated. The next `sync()` adopts the containers that key
   * already owns.
   *
   * ⛔ Takes the key's numeric id, deliberately not its name. The names *look* authoritative,
   * which is precisely why reading a binding out of one would be guesswork rather than a
   * record.
   *
   * Rejects with 409 when the key belongs to another account or is already bound elsewhere —
   * silently re-pointing a bound key would hand one app another app's bookkeeping.
   *
   * Requires a Cronvello server from 2026-09-07 or later.
   */
  bindApiKey(registrationId: number, input: ExternalAppBindApiKeyInput): Promise<ExternalAppBoundApiKey> {
    assertRegistrationId(registrationId, "bindApiKey");
    return this.t.request({
      method: "POST",
      path: `/external-apps/service/api-keys/${registrationId}/bind`,
      body: input,
    });
  }

  /**
   * Delete a registration, cascading its jobs and tasks.
   *
   * ⚠ This one takes the **numeric** {@link ExternalApp.id}, not the string `appId` the other
   * three methods take — an asymmetry in the server's route contract. Read the id off a
   * `register()` result (or a prior lookup); passing a string `appId` here is rejected locally.
   */
  delete(id: number): Promise<void> {
    if (!Number.isInteger(id) || id <= 0) {
      throw new CronvelloConfigError(
        `externalApps.delete() takes the numeric app id (ExternalApp.id), not the string appId — received ${JSON.stringify(id)}.`,
      );
    }
    return this.t.request({ method: "DELETE", path: `/external-apps/service/delete/${id}` });
  }
}

/**
 * Mirror the server's cross-field rules locally so a caller gets a precise, synchronous error
 * instead of a generic 400 from a strict schema behind a response envelope.
 */
function assertRegisterInput(input: ExternalAppRegisterInput): void {
  if (!input || typeof input !== "object") {
    throw new CronvelloConfigError("externalApps.register() requires an input object.");
  }
  if (!input.appId || !input.appId.trim()) {
    throw new CronvelloConfigError("externalApps.register() requires a non-empty `appId`.");
  }
  if (!input.name || !input.name.trim()) {
    throw new CronvelloConfigError("externalApps.register() requires a non-empty `name`.");
  }
  if (!input.base_url && input.targetUrl === undefined) {
    throw new CronvelloConfigError("externalApps.register() requires either `base_url` or `targetUrl`.");
  }

  // The server infers `oauth` from the presence of oauth fields when authMethod is omitted.
  const authMethod =
    input.authMethod ?? (input.oauthClientId || input.oauthClientSecret ? "oauth" : "api_key");

  if (authMethod === "api_key" && !input.apiKey && !input.generateApiKey) {
    throw new CronvelloConfigError(
      "externalApps.register() with api_key auth requires either `apiKey` or `generateApiKey: true`.",
    );
  }
  if (authMethod === "oauth" && (!input.oauthClientId || !input.oauthClientSecret)) {
    throw new CronvelloConfigError(
      "externalApps.register() with oauth auth requires both `oauthClientId` and `oauthClientSecret`.",
    );
  }
}

function assertAppId(appId: string, method: string): void {
  if (typeof appId !== "string" || !appId.trim()) {
    throw new CronvelloConfigError(`externalApps.${method}() requires a non-empty string appId.`);
  }
}

/**
 * The anchor methods address a registration by its NUMERIC id, never by its label — the
 * whole point of an anchor is that it does not depend on a name. Passing the string appId
 * here is the one mistake worth catching before it reaches the wire.
 */
function assertRegistrationId(id: number, method: string): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new CronvelloConfigError(
      `externalApps.${method}() takes the numeric registration id (ExternalApp.id), not the string appId — received ${JSON.stringify(id)}.`,
    );
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
