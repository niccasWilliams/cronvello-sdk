/**
 * Minimal HTTP transport over the global `fetch` (Node 20+). No axios, no node-fetch —
 * zero runtime dependencies. Adds bearer auth, JSON (de)serialization, typed error mapping,
 * bounded retries with backoff for transient failures, and optional idempotency keys.
 */

import {
  CronvelloApiError,
  CronvelloConfigError,
  CronvelloNetworkError,
} from "./errors.js";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** Max retry attempts for 429/5xx/network errors. Default 2 (=> up to 3 tries). */
  maxRetries?: number;
  /** Override the fetch implementation (testing / custom agents). */
  fetch?: FetchLike;
  /** Extra headers sent on every request (e.g. a custom User-Agent). */
  defaultHeaders?: Record<string, string>;
  /** Telemetry hook — called once per completed attempt. */
  onRequest?: (info: { method: string; path: string; status: number; attempt: number; durationMs: number }) => void;
}

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Idempotency-Key header value — replays of the same key are de-duplicated server-side. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class Transport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders: Record<string, string>;
  private readonly onRequest: TransportOptions["onRequest"];

  constructor(opts: TransportOptions) {
    if (!opts.apiKey) throw new CronvelloConfigError("apiKey is required");
    if (!opts.baseUrl) throw new CronvelloConfigError("baseUrl is required");
    const resolvedFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!resolvedFetch) {
      throw new CronvelloConfigError(
        "No global fetch found. Use Node 20+ or pass a `fetch` implementation in the client options.",
      );
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = resolvedFetch;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.onRequest = opts.onRequest;
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const endpoint = `${opts.method} ${opts.path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
      ...this.defaultHeaders,
    };
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      const { signal, cancel } = this.withTimeout(opts.signal);
      try {
        const res = await this.fetchImpl(url, {
          method: opts.method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
          signal,
        });
        cancel();
        const durationMs = Date.now() - startedAt;
        this.onRequest?.({ method: opts.method, path: opts.path, status: res.status, attempt, durationMs });

        const text = await res.text();
        const parsed = text ? safeJson(text) : null;

        if (res.ok) return unwrapEnvelope(parsed) as T;

        const retryAfter = parseRetryAfter(res, parsed);
        if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
          await sleep(this.backoff(attempt, retryAfter));
          continue;
        }
        throw new CronvelloApiError({
          status: res.status,
          endpoint,
          message: extractMessage(parsed) ?? `Request failed`,
          code: extractCode(parsed),
          body: parsed,
          ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
        });
      } catch (err) {
        cancel();
        if (err instanceof CronvelloApiError) throw err;
        // Network/abort error — retry if attempts remain.
        lastError = err;
        if (attempt < this.maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw new CronvelloNetworkError(endpoint, err);
      }
    }
    // Unreachable, but satisfies the type checker.
    throw new CronvelloNetworkError(endpoint, lastError);
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const base = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    if (!query) return base;
    const params = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return params.length ? `${base}?${params.join("&")}` : base;
  }

  private withTimeout(external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cancel: () => {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
      },
    };
  }

  private backoff(attempt: number, retryAfterSeconds?: number): number {
    if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, 30_000);
    // Exponential backoff with full jitter: base 300ms, capped at 5s.
    const base = Math.min(300 * 2 ** attempt, 5_000);
    return Math.floor(Math.random() * base);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The Cronvello server wraps every successful `/v1` response in a `{ success, message, data }`
 * envelope, while the typed client methods are declared in terms of the inner payload. Unwrap
 * it here — centrally — so every resource method (and the high-level `sync()`) sees the data it
 * expects. Bodies that aren't enveloped (no boolean `success` + `data`) pass through unchanged,
 * so non-enveloped or future endpoints keep working.
 */
function unwrapEnvelope(body: unknown): unknown {
  if (
    body !== null &&
    typeof body === "object" &&
    "success" in body &&
    typeof (body as { success: unknown }).success === "boolean" &&
    "data" in body
  ) {
    return (body as { data: unknown }).data;
  }
  return body;
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}

function extractCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "code" in body) {
    const c = (body as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function parseRetryAfter(
  res: { headers: { get(name: string): string | null } },
  body: unknown,
): number | undefined {
  const header = res.headers.get("retry-after");
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n)) return n;
  }
  if (body && typeof body === "object" && "data" in body) {
    const data = (body as { data?: { retryAfterSeconds?: unknown } }).data;
    if (data && typeof data.retryAfterSeconds === "number") return data.retryAfterSeconds;
  }
  return undefined;
}
