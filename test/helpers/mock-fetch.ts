/**
 * Test doubles for the transport's `FetchLike` seam.
 *
 * The SDK never imports a real HTTP library — `Transport` takes a `fetch` implementation, so
 * tests inject a scripted one here. `mockFetch` records every call and replays queued responses;
 * `enveloped`/`errorBody` build the exact `{ success, message, data }` wire shapes the server emits.
 */

import type { FetchLike } from "../../src/internal/http.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** Parsed JSON body, or undefined when there was no body / it wasn't JSON. */
  json: unknown;
}

export interface MockResponseSpec {
  status?: number;
  /** Response payload — serialized to JSON unless it is already a string. */
  body?: unknown;
  /** Extra response headers (e.g. `retry-after`). Keys are matched case-insensitively. */
  headers?: Record<string, string>;
  /** Throw this instead of resolving — models a network/DNS/abort failure. */
  throw?: unknown;
}

export interface MockFetch {
  fetch: FetchLike;
  calls: RecordedCall[];
  /** The single most recent call (throws if there were none). */
  lastCall(): RecordedCall;
}

function makeResponse(spec: MockResponseSpec) {
  const status = spec.status ?? 200;
  const headerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(spec.headers ?? {})) headerMap.set(k.toLowerCase(), v);
  const text = typeof spec.body === "string" ? spec.body : spec.body === undefined ? "" : JSON.stringify(spec.body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    text: async () => text,
  };
}

/**
 * Build a scripted fetch. Pass either a fixed queue of responses (consumed in order; the last one
 * repeats once exhausted) or a function that decides per call.
 */
export function mockFetch(script: MockResponseSpec[] | ((call: RecordedCall, index: number) => MockResponseSpec)): MockFetch {
  const calls: RecordedCall[] = [];
  const queue = Array.isArray(script) ? [...script] : null;

  const fetch: FetchLike = async (url, init) => {
    const body = init?.body;
    let json: unknown;
    if (typeof body === "string") {
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: lowerHeaders(init?.headers),
      body,
      json,
    };
    calls.push(call);

    // Honour an aborted signal exactly like real fetch — reject with an AbortError.
    if (init?.signal?.aborted) {
      throw abortError();
    }

    const spec = queue ? (queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 200 }) : script(call, calls.length - 1);
    if (spec.throw !== undefined) throw spec.throw;
    return makeResponse(spec);
  };

  return {
    fetch,
    calls,
    lastCall() {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mockFetch: no calls were recorded");
      return c;
    },
  };
}

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

export function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** Wrap a payload in the server's success envelope: `{ success, message, data }`. */
export function enveloped<T>(data: T, message = "OK"): { success: true; message: string; data: T } {
  return { success: true, message, data };
}

/** The server's error envelope shape. */
export function errorBody(message: string, opts: { code?: string; data?: unknown } = {}): Record<string, unknown> {
  return {
    success: false,
    message,
    ...(opts.code !== undefined ? { code: opts.code } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
  };
}
