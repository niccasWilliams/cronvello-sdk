/**
 * Express adapter. Zero dependency on `express` itself — the request/response are typed
 * structurally, so this works with Express 4/5 and any Connect-style middleware stack.
 *
 *   import { defineCronvello } from "@cronvello/sdk";
 *   import { expressHandler } from "@cronvello/sdk/express";
 *
 *   app.post("/cronvello/dispatch", express.json(), expressHandler(cronvello));
 *   // …or simply: app.post(cronvello.dispatchPath, express.json(), cronvello.expressHandler());
 *
 * Works with or without `express.json()` — if the body isn't pre-parsed, the raw stream is read.
 */

import type { DispatchHandler } from "../registry/dispatch-handler.js";

export interface ExpressRequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?(event: string, listener: (chunk?: unknown) => void): void;
}

export interface ExpressResponseLike {
  status(code: number): ExpressResponseLike;
  json(body: unknown): void;
}

export type ExpressDispatchHandler = (req: ExpressRequestLike, res: ExpressResponseLike) => Promise<void>;

export function expressHandler(app: DispatchHandler): ExpressDispatchHandler {
  return async (req, res) => {
    const rawBody = await readBody(req);
    const result = await app.handle({
      method: req.method ?? "POST",
      authorization: headerValue(req.headers["authorization"]),
      rawBody,
      headers: flattenHeaders(req.headers),
    });
    res.status(result.status).json(result.body);
  };
}

async function readBody(req: ExpressRequestLike): Promise<string> {
  const body = req.body;
  if (body !== undefined && body !== null) {
    if (typeof body === "string") return body;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) return body.toString("utf8");
    if (typeof body === "object") return JSON.stringify(body);
  }
  if (typeof req.on !== "function") return "";
  return new Promise<string>((resolve) => {
    let data = "";
    req.on!("data", (chunk?: unknown) => {
      data += typeof chunk === "string" ? chunk : String(chunk ?? "");
    });
    req.on!("end", () => resolve(data));
    req.on!("error", () => resolve(data));
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
