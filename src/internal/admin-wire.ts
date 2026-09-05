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

/** Result of a key rotation. `newApiKey` is plaintext and returned exactly once. */
export interface ExternalAppRotateKeyResult extends ExternalApp {
  newApiKey: string;
}

/** Registration status for one app, keyed by its string `appId`. */
export interface ExternalAppStatus {
  /** `false` when no app with that `appId` exists; every other field is then at its zero value. */
  registered: boolean;
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
}
