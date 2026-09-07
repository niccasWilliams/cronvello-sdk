/**
 * Wire types for Cronvello's operator ("service") API — `/external-apps/service/*`.
 *
 * This is NOT the per-account `/v1` API. It is the backend-to-backend control plane that
 * registers, inspects, re-keys and removes the *external apps* Cronvello schedules jobs for.
 * It lives on the same host as `/v1` but behind a different credential — see
 * {@link ../client/admin-client.js CronvelloAdminClient}.
 *
 * Hand-authored plain TypeScript (mirroring the server's Zod DTOs and route contracts) so the
 * SDK keeps ZERO runtime dependencies. When the server contract changes, update these to match.
 */

import type { Urgency } from "./wire.js";

/** How Cronvello authenticates itself towards a registered external app. */
export type ExternalAppAuthMethod = "api_key" | "oauth";

/**
 * Why the hourly catalog poll was retired for a registration.
 *
 * - `self_managed` — the app drives its own tasks through `@cronvello/sdk`; polling would delete them.
 * - `catalog_gone` — the job-catalog route 404s.
 * - `auth_rejected` — the catalog route rejected our credentials over a sustained period.
 *
 * Widened to `string` so a newly introduced server-side reason does not break the type.
 */
export type CatalogRetiredReason = "self_managed" | "catalog_gone" | "auth_rejected" | (string & {});

/**
 * A registered external app as the server returns it.
 *
 * Secrets are never returned in plaintext: `apiKey` and `oauthClientSecret` are always `null`,
 * with masked previews alongside them. The one-time plaintext token appears only in
 * {@link ExternalAppRegisterResult.generatedApiKey} and {@link ExternalAppRotateKeyResult.newApiKey}.
 *
 * Timestamps arrive as JSON strings.
 */
export interface ExternalApp {
  /** Numeric primary key. This — not {@link appId} — is what `externalApps.delete()` takes. */
  id: number;
  /** Caller-chosen stable string identifier, e.g. `"node-shop"`. Unique. */
  appId: string;
  name: string;
  description: string | null;
  /** Always `null`; the plaintext key is never echoed back. See {@link apiKeyMasked}. */
  apiKey: null;
  apiKeyMasked: string | null;
  hasApiKey: boolean;
  oauthClientId: string | null;
  /** Always `null`. See {@link oauthClientSecretMasked}. */
  oauthClientSecret: null;
  oauthClientSecretMasked: string | null;
  hasOAuthClientSecret: boolean;
  authMethod: ExternalAppAuthMethod;
  /** Base URL Cronvello calls back on. Snake_case on the wire — the server's column name. */
  base_url: string;
  createdAt: string;
  isActive: boolean;
  /** Maintained by the server's liveness monitor; not something a caller sets directly. */
  isLive: boolean;
  /** FK into the server's job-target-url table. */
  targetUrl: number;
  /** Path under `base_url` that serves the app's job catalog. Server default: `/cron-jobs`. */
  jobRoutePath: string | null;
  urgency: Urgency;
  lastSyncedAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthCheckMs: number | null;
  totalJobCount: number | null;
  activeJobCount: number | null;
  livenessMonitoringEnabled: boolean;
  consecutiveUnreachableCount: number;
  consecutiveSyncFailureCount: number;
  lastSyncFailureAt: string | null;
  lastSyncError: string | null;
  catalogRetiredAt: string | null;
  catalogRetiredReason: CatalogRetiredReason | null;
  webhookCallbackEnabled: boolean;
  /** Stored encrypted at rest; the server does not mask this field. */
  webhookCallbackSecret: string | null;
  webhookCallbackTimeoutMs: number | null;
  /** `null` for system/B2B apps owned internally rather than by an account. */
  accountId: number | null;
}

/**
 * Body of `POST /external-apps/service/register`.
 *
 * The server validates this strictly — unknown properties are rejected. Cross-field rules
 * (also checked client-side before the request leaves, so you get a `CronvelloConfigError`
 * instead of an opaque 400):
 *
 * - exactly one of `base_url` or `targetUrl` must be present (at least one);
 * - with `authMethod: "api_key"` (the default) you must supply either `apiKey` or `generateApiKey: true`;
 * - with `authMethod: "oauth"` both `oauthClientId` and `oauthClientSecret` are required.
 */
export interface ExternalAppRegisterInput {
  /** Stable string identifier. Existing value ⇒ update; new value ⇒ create. */
  appId: string;
  name: string;
  description?: string | null;
  /** Bring your own per-app token. Mutually exclusive with `generateApiKey`. */
  apiKey?: string;
  /**
   * Let Cronvello mint the per-app token. It comes back exactly once as
   * {@link ExternalAppRegisterResult.generatedApiKey} — persist it there and then, or rotate.
   */
  generateApiKey?: boolean;
  base_url?: string;
  /** Existing job-target-url id, as an alternative to `base_url`. */
  targetUrl?: number;
  /** Defaults to `/cron-jobs` server-side when omitted. */
  jobRoutePath?: string;
  authMethod?: ExternalAppAuthMethod;
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** Defaults to `true` server-side when omitted. */
  isActive?: boolean;
  webhookCallbackEnabled?: boolean;
  /** Required by the server when `webhookCallbackEnabled` is true. Minimum 32 characters. */
  webhookCallbackSecret?: string;
  /** Server-enforced range: 10_000 – 3_600_000 ms. */
  webhookCallbackTimeoutMs?: number;
}

/**
 * Result of a register (upsert) call.
 *
 * `generatedApiKey` carries the plaintext token **once**, and only when the server minted it
 * for a newly created app via `generateApiKey`. On an update, or when you supplied your own
 * `apiKey`, it is `null`. There is no second chance to read it — use `rotateKey()` if it is lost.
 */
export interface ExternalAppRegisterResult extends ExternalApp {
  generatedApiKey: string | null;
}

/**
 * Result of a key rotation. `newApiKey` is plaintext and returned exactly once.
 *
 * `previousApiKeyExpiresAt` is the end of the grace period during which the replaced token
 * can still be restored with {@link ExternalAppsResource.rollbackKey}. It is `null` when the
 * app had no token to replace, or when the caller asked for `gracePeriodHours: 0`.
 */
export interface ExternalAppRotateKeyResult extends ExternalApp {
  newApiKey: string;
  previousApiKeyExpiresAt: string | null;
}

/** Options for {@link ExternalAppsResource.rotateKey}. */
export interface ExternalAppRotateKeyInput {
  /**
   * How long the replaced token stays restorable. Server default is 2 hours; `0` turns the
   * rotation back into a hard cut — which is a legitimate choice, just an explicit one.
   * Server-enforced range: 0 – 168.
   */
  gracePeriodHours?: number;
}

/** Result of {@link ExternalAppsResource.rollbackKey}. `restoredApiKey` is plaintext. */
export interface ExternalAppRollbackKeyResult extends ExternalApp {
  restoredApiKey: string;
}

/** Options for {@link ExternalAppsResource.revokeKey}. */
export interface ExternalAppRevokeKeyInput {
  /** Why the credential was withdrawn. Shows up in the status as the reason. Max 64 chars. */
  reason?: string;
}

/**
 * Result of {@link ExternalAppsResource.revokeKey}.
 *
 * `tasksCleared` counts the task rows whose stored copy of the token was emptied along with
 * it — a revoked value left lying in task rows would be a secret nobody watches any more.
 */
export interface ExternalAppRevokeKeyResult extends ExternalApp {
  tasksCleared: number;
}

/** Registration status for one app, addressed either by its string `appId` or by its numeric id. */
export interface ExternalAppStatus {
  /** `false` when no such app exists; every other field is then at its zero value. */
  registered: boolean;
  /**
   * The label the server currently files this registration under, or `null` when it is not
   * registered.
   *
   * Worth reading even though you passed an identifier in: when you looked the row up by its
   * numeric id and this comes back different from the `appId` you have on file, your copy of
   * the label is stale — the app was renamed on one side only. Without this field a rename is
   * indistinguishable from a deletion, which is exactly how a live connection came to report
   * "not registered" for days while it kept delivering jobs.
   */
  appId: string | null;
  isActive: boolean;
  lastSyncedAt: string | null;
  isLive: boolean;
  jobCount: number;
  /**
   * How the app authenticates, or `null` when it is not registered.
   *
   * The four fields from here down describe the **state** of the app's credential, never
   * its value. They exist so an operator can verify that a registration is still backed by
   * a usable secret with a *read*. Before they were added, the only responses carrying that
   * information were {@link ExternalAppsResource.register} and
   * {@link ExternalAppsResource.rotateKey} — an upsert and a key mint. A health check built
   * on either one writes on every pass, and `rotateKey` invalidates the very token it was
   * asked about.
   */
  authMethod: ExternalAppAuthMethod | null;
  /** Whether a per-app token is stored. `registered: true` with `hasApiKey: false` is a real state: the registration outlived its secret. */
  hasApiKey: boolean;
  /** Masked form of the stored token — enough to tell two secrets apart across calls, never enough to use one. */
  apiKeyMasked: string | null;
  hasOAuthClientSecret: boolean;
  /** When the server last checked the app's reachability. `null` when never checked. */
  lastHealthCheckAt: string | null;
  /**
   * What {@link isLive} actually means for this row.
   *
   * ⭐ Read this instead of `isLive` when you paint a status badge. `is_live` is the result of
   * the hourly catalog poll, not a statement about whether the app's jobs run. A retired or
   * deactivated registration sits at `false` permanently — correctly, because nothing is
   * supposed to be polled there — and a caller that turns that into a red badge reports
   * healthy things as outages. One operator's landscape did exactly that while the same
   * instance was running 18,696 of 18,711 job executions on HTTP 200.
   *
   * Only `unreachable` is a fault. Older servers omit the field entirely.
   */
  liveness?: {
    state: "live" | "unreachable" | "retired" | "inactive" | "not_monitored" | "revoked";
    detail: string;
  };
  /**
   * One fingerprint per secret this registration holds — never a value. Lets a caller locate
   * the value in the app's runtime environment by equality instead of guessing a variable
   * name. During a rotation grace period two entries stand side by side, and that is how a
   * caller can see that the other side is still on the old value instead of assuming it.
   *
   * Older servers omit the field.
   */
  credentialFingerprints?: Array<{
    role: "api_key" | "previous_api_key" | "oauth_client_secret";
    fingerprint: string;
    /** `false` = replaced, still restorable while the grace period runs. */
    current: boolean;
    expiresAt: string | null;
  }>;
  /**
   * Set when the credential was withdrawn with {@link ExternalAppsResource.revokeKey}. Without
   * it an empty fingerprint list reads as "something is missing" rather than "someone decided".
   */
  credentialRevokedAt?: string | null;
  credentialRevokedReason?: string | null;
}

/**
 * One row of {@link ExternalAppsResource.list} — the same projection as
 * {@link ExternalAppStatus}, plus the numeric pointer.
 *
 * The pointer is what makes a listing usable. Matching rows by their label is what let a
 * renamed app look deleted; a list that only carried labels would hand the caller the same
 * trap in bulk.
 */
export interface ExternalAppRegistration extends ExternalAppStatus {
  /** The numeric id to address this row with from now on — the same one `register()` returns. */
  registrationId: number;
}

/** The answer of {@link ExternalAppsResource.list}. */
export interface ExternalAppRegistrationList {
  count: number;
  registrations: ExternalAppRegistration[];
}
