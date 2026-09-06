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
  ExternalAppRegisterInput,
  ExternalAppRegisterResult,
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

class ExternalAppsResource {
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
   * and must be written into the app's environment — the previous one stops working.
   *
   * Use this for drift recovery when the current token is no longer known.
   */
  rotateKey(appId: string): Promise<ExternalAppRotateKeyResult> {
    assertAppId(appId, "rotateKey");
    return this.t.request({ method: "POST", path: `/external-apps/service/rotate-key/${enc(appId)}` });
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

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
