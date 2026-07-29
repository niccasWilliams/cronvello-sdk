import { describe, expect, it } from "vitest";
import { expressHandler, type ExpressRequestLike, type ExpressResponseLike } from "../../src/adapters/express.js";
import { nextHandler, type FetchRequestLike } from "../../src/adapters/next.js";
import type { DispatchHandler } from "../../src/registry/dispatch-handler.js";
import type { DispatchRequest, DispatchResponse } from "../../src/registry/dispatch.js";

/** A dispatch handler that just echoes back what it received, so adapter translation is observable. */
function echoHandler(): { handler: DispatchHandler; seen: DispatchRequest[] } {
  const seen: DispatchRequest[] = [];
  const handler: DispatchHandler = {
    async handle(req): Promise<DispatchResponse> {
      seen.push(req);
      return { status: 200, body: { ok: true, got: req.rawBody } };
    },
  };
  return { handler, seen };
}

function fakeRes(): ExpressResponseLike & { statusCode: number; payload: unknown } {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.payload = body; },
  };
  return res;
}

describe("express adapter", () => {
  it("reads a pre-parsed JSON object body and flattens headers", async () => {
    const { handler, seen } = echoHandler();
    const res = fakeRes();
    const req: ExpressRequestLike = {
      method: "POST",
      headers: { authorization: "Bearer s", "x-multi": ["a", "b"], skip: undefined },
      body: { job: "digest" },
    };
    await expressHandler(handler)(req, res);
    expect(res.statusCode).toBe(200);
    expect(seen[0]!.authorization).toBe("Bearer s");
    expect(JSON.parse(seen[0]!.rawBody)).toEqual({ job: "digest" });
    expect(seen[0]!.headers["x-multi"]).toBe("a, b");
    expect("skip" in seen[0]!.headers).toBe(false);
  });

  it("passes a string body through verbatim", async () => {
    const { handler, seen } = echoHandler();
    await expressHandler(handler)({ method: "POST", headers: {}, body: '{"job":"x"}' }, fakeRes());
    expect(seen[0]!.rawBody).toBe('{"job":"x"}');
  });

  it("stringifies a Buffer body", async () => {
    const { handler, seen } = echoHandler();
    await expressHandler(handler)({ method: "POST", headers: {}, body: Buffer.from('{"job":"b"}') }, fakeRes());
    expect(seen[0]!.rawBody).toBe('{"job":"b"}');
  });

  it("reads a raw stream when the body was not pre-parsed", async () => {
    const { handler, seen } = echoHandler();
    const listeners: Record<string, (chunk?: unknown) => void> = {};
    const req: ExpressRequestLike = {
      method: "POST",
      headers: {},
      on(event, listener) { listeners[event] = listener; },
    };
    const p = expressHandler(handler)(req, fakeRes());
    listeners["data"]!("{\"job\":");
    listeners["data"]!("\"stream\"}");
    listeners["end"]!();
    await p;
    expect(JSON.parse(seen[0]!.rawBody)).toEqual({ job: "stream" });
  });

  it("defaults the method to POST when absent", async () => {
    const { handler, seen } = echoHandler();
    await expressHandler(handler)({ headers: {}, body: {} }, fakeRes());
    expect(seen[0]!.method).toBe("POST");
  });
});

describe("next adapter", () => {
  function fetchReq(over: Partial<{ method: string; body: string; headers: Record<string, string> }> = {}): FetchRequestLike {
    const headers = over.headers ?? {};
    return {
      method: over.method ?? "POST",
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
        forEach: (cb) => { for (const [k, v] of Object.entries(headers)) cb(v, k); },
      },
      text: async () => over.body ?? "",
    };
  }

  it("translates a Fetch Request and returns a JSON Response", async () => {
    const { handler, seen } = echoHandler();
    const res = await nextHandler(handler)(fetchReq({
      body: JSON.stringify({ job: "digest" }),
      headers: { authorization: "Bearer s", "x-trace": "t1" },
    }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toMatchObject({ ok: true });
    expect(seen[0]!.authorization).toBe("Bearer s");
    expect(seen[0]!.headers["x-trace"]).toBe("t1");
  });

  it("passes through the status from the dispatch result", async () => {
    const handler: DispatchHandler = { async handle() { return { status: 401, body: { ok: false } }; } };
    const res = await nextHandler(handler)(fetchReq());
    expect(res.status).toBe(401);
  });
});
