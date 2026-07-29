/**
 * The **local dashboard** — a tiny `node:http` server (zero runtime dependencies) that observes a
 * running {@link LocalEngine} and renders it in a branded single-page UI. The engine stays the only
 * source of truth for scheduling; the dashboard only *reads* it (snapshot / history / live events)
 * and offers exactly one write path: a manual "run now" trigger.
 *
 * It is a developer tool, not a public server: it binds to `127.0.0.1` by default, never `0.0.0.0`,
 * speaks only to same-origin callers for mutations, makes no outbound network calls, and sends no
 * telemetry. Start it with {@link startDashboard}, or via `app.dev({ dashboard: true })` /
 * `cronvello dev --dashboard`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LocalEngine } from "./engine.js";
import { previewSchedule } from "../internal/cron-schedule.js";
import { DASHBOARD_HTML } from "./dashboard-assets.js";

export interface DashboardOptions {
  /** Port to listen on. Default `4747`. Use `0` to let the OS pick a free port (handy in tests). */
  port?: number;
  /** Host/interface to bind. Default `127.0.0.1` — keep it loopback; this is not a public server. */
  host?: string;
}

export interface DashboardHandle {
  /** The local URL the dashboard is reachable at, e.g. `http://127.0.0.1:4747`. */
  url: string;
  /** The actual port bound (resolved even when `port: 0` was requested). */
  port: number;
  /** Stop the server and drop every live SSE connection. Idempotent. */
  close(): Promise<void>;
}

const DEFAULT_PORT = 4747;
const DEFAULT_HOST = "127.0.0.1";
const HEARTBEAT_MS = 15_000;
const MAX_PREVIEW = 50;

/**
 * Start the dashboard server for an engine. Resolves once it is listening; rejects with a clear
 * message if the port is already in use. Bind defaults to loopback.
 */
export function startDashboard(engine: LocalEngine, options: DashboardOptions = {}): Promise<DashboardHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const sseClients = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => handleRequest(engine, sseClients, req, res));

  return new Promise<DashboardHandle>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("error", onError);
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Cronvello dashboard: port ${port} on ${host} is already in use — pass a different --port.`));
      } else {
        reject(err);
      }
    };
    server.once("error", onError);

    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const actualPort = (server.address() as AddressInfo).port;
      const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      const url = `http://${shown}:${actualPort}`;

      let closed = false;
      const close = (): Promise<void> => {
        if (closed) return Promise.resolve();
        closed = true;
        for (const client of sseClients) client.end();
        sseClients.clear();
        return new Promise<void>((res2) => {
          // closeAllConnections (Node ≥18.2) drops lingering keep-alive sockets so this resolves
          // promptly instead of waiting on idle connections.
          server.closeAllConnections?.();
          server.close(() => res2());
        });
      };

      resolve({ url, port: actualPort, close });
    });
  });
}

function handleRequest(
  engine: LocalEngine,
  sseClients: Set<http.ServerResponse>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Landing page.
  if (method === "GET" && path === "/") {
    return sendHtml(res, DASHBOARD_HTML);
  }

  // Live event stream (Server-Sent Events).
  if (method === "GET" && path === "/api/events") {
    return openEventStream(engine, sseClients, req, res);
  }

  // Health.
  if (method === "GET" && path === "/api/health") {
    return sendJson(res, 200, { ok: true, jobs: engine.jobs().length, activeRuns: engine.activeRuns });
  }

  // Run history as NDJSON (check before the `/api/runs` prefix).
  if (method === "GET" && path === "/api/runs.ndjson") {
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
    const body = engine.toNdjson();
    return void res.end(body.length ? body + "\n" : "");
  }

  // Run history (all, or `?key=`).
  if (method === "GET" && path === "/api/runs") {
    const key = url.searchParams.get("key");
    return sendJson(res, 200, key ? engine.runsFor(key) : engine.runs());
  }

  // Run history for one job.
  if (method === "GET" && path.startsWith("/api/runs/")) {
    return sendJson(res, 200, engine.runsFor(decodeKey(path, "/api/runs/")));
  }

  // Upcoming fire times for one job.
  if (method === "GET" && path.startsWith("/api/preview/")) {
    const key = decodeKey(path, "/api/preview/");
    const job = engine.snapshot().find((j) => j.key === key);
    if (!job) return sendJson(res, 404, { error: `unknown job '${key}'` });
    const n = clampCount(url.searchParams.get("n"));
    try {
      const fires = previewSchedule(job.schedule, { timeZone: job.timeZone, count: n });
      return sendJson(res, 200, fires.map((d) => d.toISOString()));
    } catch {
      return sendJson(res, 200, []); // an unschedulable expression simply has no upcoming fires
    }
  }

  // Snapshot of all jobs.
  if (method === "GET" && path === "/api/jobs") {
    const jobs = engine.snapshot().map((j) => ({
      key: j.key,
      schedule: j.schedule,
      timeZone: j.timeZone,
      description: j.description,
      nextFire: j.nextFire ? j.nextFire.toISOString() : null,
      running: j.running,
    }));
    return sendJson(res, 200, jobs);
  }

  // Manual trigger — the one mutating path. Guard against cross-origin POSTs.
  if (method === "POST" && path.startsWith("/api/trigger/")) {
    if (!isSameOrigin(req)) return sendJson(res, 403, { error: "cross-origin request rejected" });
    const key = decodeKey(path, "/api/trigger/");
    return void engine
      .trigger(key)
      .then((record) => sendJson(res, 200, record))
      .catch((err: Error) => {
        const status = /unknown job/.test(err.message) ? 404 : 400;
        sendJson(res, status, { error: err.message });
      });
  }

  sendJson(res, 404, { error: "not found" });
}

/** Open an SSE stream that forwards every engine event until the client disconnects. */
function openEventStream(
  engine: LocalEngine,
  sseClients: Set<http.ServerResponse>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  sseClients.add(res);

  const unsubscribe = engine.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  // Heartbeat comment keeps proxies from idling the connection out.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    sseClients.delete(res);
  };
  res.on("close", cleanup);
  req.on("close", cleanup);
}

// ── helpers ────────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function decodeKey(path: string, prefix: string): string {
  return decodeURIComponent(path.slice(prefix.length));
}

function clampCount(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : 5;
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(n, MAX_PREVIEW);
}

/**
 * Reject a mutating request whose `Origin` points at a different host than the one it was sent to.
 * Loopback binding is the primary defence; this stops a page on another local origin from POSTing.
 */
function isSameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, tests) send no Origin
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
