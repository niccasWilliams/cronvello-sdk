import { afterEach, describe, expect, it, vi } from "vitest";
import { defineCronvello } from "../../src/registry/define.js";
import { createDispatcher, type DispatcherState, type DispatchRequest } from "../../src/registry/dispatch.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function request(async = false, extra: Partial<DispatchRequest> = {}): DispatchRequest {
  return { method: "POST", authorization: "Bearer test-dispatch-secret", headers: {},
    rawBody: JSON.stringify({ job: "work", ...(async ? { _callback: { url: "https://callback.invalid/run", runId: "run1" } } : {}) }), ...extra };
}
function fixture(options: Partial<DispatcherState> = {}) {
  const release = vi.fn(), handler = vi.fn(async () => "ok");
  const acquireRun = vi.fn(() => ({ release }));
  const dispatcher = createDispatcher({
    jobs: new Map([["work", { key: "work", config: { schedule: "* * * * *", handler } }]]),
    dispatchSecret: "test-dispatch-secret", logger: {}, acquireRun, ...options,
  });
  return { dispatcher, handler, acquireRun, release };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("host run admission", () => {
  it.each([false, true])("refuses dispatch before hooks and handler, including async=%s", async async => {
    const start = vi.fn(), rejection = new Error("private host placement");
    const f = fixture({ hooks: { onJobStart: start }, acquireRun: () => { throw rejection; } });
    const response = await f.dispatcher.handle(request(async));
    expect(response).toMatchObject({ status: 503 });
    expect(JSON.stringify(response)).not.toContain(rejection.message);
    expect(f.handler).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("performs authentication and registry validation before acquiring host work", async () => {
    const f = fixture();
    expect((await f.dispatcher.handle(request(false, { authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await f.dispatcher.handle(request(false, { rawBody: '{"job":"unknown"}' }))).status).toBe(404);
    expect(f.acquireRun).not.toHaveBeenCalled();
  });
  it("retains admission through a slow success hook after the handler resolves", async () => {
    const success = deferred<void>(), reached = deferred<void>();
    const f = fixture({ hooks: { onJobSuccess: async () => { reached.resolve(); await success.promise; } } });
    const result = f.dispatcher.handle(request());
    await reached.promise;
    expect(f.handler).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled();
    success.resolve(); expect((await result).status).toBe(200); expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.acquireRun).toHaveBeenCalledWith({ key: "work", source: "dispatch", isAsync: false });
  });
  it("retains admission through a slow error hook and releases once on failure", async () => {
    const errorHook = deferred<void>(), reached = deferred<void>();
    const f = fixture({ hooks: { onJobError: async () => { reached.resolve(); await errorHook.promise; } } });
    f.handler.mockRejectedValue(new Error("handler failed"));
    const result = f.dispatcher.handle(request());
    await reached.promise; expect(f.release).not.toHaveBeenCalled();
    errorHook.resolve(); expect((await result).status).toBe(500); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("does not release async work at HTTP202 or after the handler, but after callback delivery", async () => {
    const response = deferred<{ ok: boolean; status: number }>(), entered = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async () => { entered.resolve(); return response.promise; }));
    const f = fixture(); let work: Promise<unknown> | undefined;
    expect((await f.dispatcher.handle(request(true, { waitUntil: promise => { work = promise; } }))).status).toBe(202);
    expect(f.release).not.toHaveBeenCalled();
    await entered.promise;
    expect(f.handler).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled();
    response.resolve({ ok: true, status: 200 }); await work; expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("retains async admission through every retry, including the final delivery failure", async () => {
    vi.useFakeTimers();
    const reached = deferred<void>();
    const fetch = vi.fn(async () => { reached.resolve(); return { ok: false, status: 503 }; });
    vi.stubGlobal("fetch", fetch);
    const f = fixture(); let work: Promise<unknown> | undefined;
    await f.dispatcher.handle(request(true, { waitUntil: promise => { work = promise; } }));
    await reached.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2); expect(f.release).not.toHaveBeenCalled();
    await vi.runAllTimersAsync(); await work;
    expect(fetch).toHaveBeenCalledTimes(4); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("releases a callback serialization failure without an unhandled background rejection", async () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    const handler = vi.fn(async () => cyclic), release = vi.fn(), error = vi.fn();
    const f = fixture({ jobs: new Map([["work", { key: "work", config: { schedule: "* * * * *", handler } }]]),
      acquireRun: () => ({ release }), logger: { error } });
    let work: Promise<unknown> | undefined;
    await f.dispatcher.handle(request(true, { waitUntil: promise => { work = promise; } }));
    await expect(work).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
  });
  it("uses independent leases for concurrent runs of the same job key", async () => {
    const first = deferred<void>(), second = deferred<void>(), hooks = deferred<void>();
    const releases = [vi.fn(), vi.fn()]; let n = 0, runs = 0;
    const f = fixture({ acquireRun: () => ({ release: releases[n++]! }), hooks: {
      onJobSuccess: async () => { const index = runs++; if (runs === 2) hooks.resolve(); await (index ? second : first).promise; },
    } });
    const a = f.dispatcher.handle(request()), b = f.dispatcher.handle(request());
    await hooks.promise; expect(releases[0]).not.toHaveBeenCalled(); expect(releases[1]).not.toHaveBeenCalled();
    first.resolve(); await a; expect(releases[0]).toHaveBeenCalledTimes(1); expect(releases[1]).not.toHaveBeenCalled();
    second.resolve(); await b; expect(releases[1]).toHaveBeenCalledTimes(1);
  });
  it("applies the same admission to defineCronvello local triggers and releases failed hooks", async () => {
    const release = vi.fn(), acquireRun = vi.fn(() => ({ release }));
    const app = defineCronvello({ appName: "lifecycle-test", jobs: { work: { schedule: "* * * * *", handler: async () => "done" } },
      acquireRun, hooks: { onJobSuccess: () => { throw new Error("observer failed"); } } });
    expect(await app.trigger("work")).toBe("done");
    expect(acquireRun).toHaveBeenCalledWith({ key: "work", source: "local", isAsync: false });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("rejects a local trigger before running hooks or handlers when the host is draining", async () => {
    const handler = vi.fn(), start = vi.fn();
    const f = fixture({ acquireRun: () => { throw new Error("draining"); }, hooks: { onJobStart: start },
      jobs: new Map([["work", { key: "work", config: { schedule: "* * * * *", handler } }]]) });
    await expect(f.dispatcher.runLocal("work")).rejects.toThrow("draining");
    expect(handler).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
});
