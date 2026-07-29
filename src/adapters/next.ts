/**
 * Next.js App Router adapter (Route Handlers). Zero dependency on `next` — uses the Web
 * Fetch `Request`/`Response` globals (Node 20+ and the edge runtime).
 *
 *   // app/cronvello/dispatch/route.ts
 *   import { cronvello } from "@/lib/cronvello";
 *   import { nextHandler } from "@cronvello/sdk/next";
 *   export const POST = nextHandler(cronvello);
 *
 * On serverless hosts, prefer the default sync execution mode so the work finishes within the
 * request. async_callback needs a host that keeps running after the response (see docs).
 */

import type { DispatchHandler } from "../registry/dispatch-handler.js";

/** Structural subset of the Web Fetch `Request` we rely on. */
export interface FetchRequestLike {
  method: string;
  headers: {
    get(name: string): string | null;
    forEach?(cb: (value: string, key: string) => void): void;
  };
  text(): Promise<string>;
}

export type NextRouteHandler = (req: FetchRequestLike) => Promise<Response>;

export function nextHandler(app: DispatchHandler): NextRouteHandler {
  return async (req) => {
    const rawBody = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach?.((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const result = await app.handle({
      method: req.method,
      authorization: req.headers.get("authorization") ?? undefined,
      rawBody,
      headers,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
}
