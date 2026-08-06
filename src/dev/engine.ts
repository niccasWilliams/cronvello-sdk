/**
 * The **local engine** — Cronvello running entirely on your machine, with no account, no cloud, and
 * no network. It is the piece that turns `@cronvello/sdk` from a thin client into a real cron tool:
 * give it your jobs and it computes each one's next fire time, runs the handler when it's due, and
 * enforces the production policies (overlap protection, per-run timeout, retry with backoff) locally
 * — exactly the guarantees the cloud gives you, on your laptop.
 *
 * Everything is driven through an injectable {@link EngineClock}, so the whole scheduler is
 * deterministic under test (a virtual clock can fast-forward days in microseconds) and uses the real
 * `setTimeout`/`Date.now` in production. The engine never touches the network.
 */

import { nextOccurrence } from "../internal/cron-schedule.js";

/** The outcome of a single execution (which may have spanned several attempts). */
export type RunStatus = "success" | "error" | "timed_out" | "skipped";

/** One job the engine should schedule. Derived from a `defineCronvello` registry, but standalone. */
export interface EngineJob {
  /** Stable registry key. */
  key: string;
  /** Cron expression (5- or 6-field, macros). `@reboot` fires once when the engine starts. */
  schedule: string;
  /** IANA timezone the schedule is read in. */
  timeZone: string;
  /** Abort a run that exceeds this many ms (the handler's `ctx.signal` aborts). 0/undefined = no limit. */
  timeoutMs?: number;
  /** Retries after the first failed attempt (default 0). */
  maxRetries?: number;
  /** Allow a fire while a previous run of the same job is still in flight (default false). */
  allowConcurrentRuns?: boolean;
  /** Optional human description (shown in the dev table). */
  description?: string;
}

/** A completed execution recorded in the in-memory history ring buffer. */
export interface RunRecord {
  key: string;
  source: "local";
  /** Epoch ms when the execution began. */
  startedAt: number;
  /** Epoch ms when it settled. */
  finishedAt: number;
  durationMs: number;
  status: RunStatus;
  /** How many attempts were made (1 + retries that ran). */
  attempts: number;
  /** Error message for a failed/timed-out run. */
  error?: string;
  /** The handler's return value for a successful run. */
  result?: unknown;
}

/** Lifecycle events the engine emits — the CLI renders them as a live feed. */
export type EngineEvent =
  | { type: "engine-start"; jobs: number; at: number }
  | { type: "engine-stop"; at: number }
  | { type: "scheduled"; key: string; at: number }
  | { type: "fire"; key: string; attempt: number; at: number }
  | { type: "success"; key: string; durationMs: number; attempts: number; result: unknown; at: number }
  | { type: "error"; key: string; durationMs: number; attempt: number; willRetry: boolean; error: string; at: number }
  | { type: "timeout"; key: string; durationMs: number; attempt: number; willRetry: boolean; at: number }
  | { type: "retry"; key: string; attempt: number; delayMs: number; at: number }
  | { type: "skipped"; key: string; reason: "overlap"; at: number };

/** A snapshot of one job's scheduling state, for the dev table. */
export interface JobSnapshot {
  key: string;
  schedule: string;
  timeZone: string;
  description?: string;
  /** Next fire time, or null for `@reboot` / unschedulable jobs. */
  nextFire: Date | null;
  /** True while a run of this job is in flight. */
  running: boolean;
}

/**
 * The timer/clock seam. Production wires this to the global `setTimeout`/`Date.now`; tests inject a
 * virtual clock so scheduling is fully deterministic.
 */
export interface EngineClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Runs a job's handler in-process (with lifecycle hooks). `signal` aborts on timeout. */
export type EngineRunner = (key: string, signal: AbortSignal) => Promise<unknown>;

export interface LocalEngineOptions {
  /** Timer source. Defaults to the real `setTimeout`/`Date.now`. */
  clock?: EngineClock;
  /** Receives every lifecycle event (for live rendering / metrics). */
  onEvent?: (event: EngineEvent) => void;
  /** Cap on the in-memory run history (default 100). Oldest records drop first. */
  historyLimit?: number;
  /** Backoff before retry attempt N (1-based: N=1 is the delay before the 2nd attempt). */
  backoff?: (attempt: number) => number;
  /** Install SIGINT/SIGTERM handlers that stop the engine cleanly (default false). */
  installSignalHandlers?: boolean;
}

const DEFAULT_HISTORY_LIMIT = 100;
/** Node's `setTimeout` overflows past ~24.8 days; clamp long waits and re-evaluate on wake. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Default retry backoff: 0.5s, 1s, 2s, 4s … capped at 30s. Deterministic (no jitter). */
function defaultBackoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** (attempt - 1));
}

const realClock: EngineClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A timeout that crossed its budget — distinguished from a handler error so we can label the run. */
class RunTimeoutError extends Error {
  constructor(key: string, ms: number) {
    super(`job '${key}' timed out after ${ms}ms`);
    this.name = "RunTimeoutError";
  }
}

interface JobState {
  job: EngineJob;
  nextFire: number | null;
  timer: unknown;
  running: boolean;
  isReboot: boolean;
}

/**
 * Construct a local engine. Call {@link LocalEngine.start} to begin the loop and
 * {@link LocalEngine.stop} for a clean shutdown.
 */
export function createLocalEngine(jobs: EngineJob[], runner: EngineRunner, options: LocalEngineOptions = {}): LocalEngine {
  return new LocalEngine(jobs, runner, options);
}

export class LocalEngine {
  private readonly clock: EngineClock;
  /** Every event listener. The constructor's `onEvent` is registered as one of them. */
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  /** Run after the engine has drained, e.g. to close a dashboard server. */
  private readonly closeHooks: Array<() => void | Promise<void>> = [];
  private readonly historyLimit: number;
  private readonly backoff: (attempt: number) => number;
  private readonly runner: EngineRunner;
  private readonly states: JobState[];
  private readonly history: RunRecord[] = [];
  private readonly inFlight = new Set<Promise<unknown>>();
  private started = false;
  private stopped = false;
  private signalCleanup: (() => void) | null = null;
  private startedAtMs: number | null = null;

  constructor(jobs: EngineJob[], runner: EngineRunner, options: LocalEngineOptions = {}) {
    this.clock = options.clock ?? realClock;
    if (options.onEvent) this.listeners.add(options.onEvent);
    this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    this.backoff = options.backoff ?? defaultBackoff;
    this.runner = runner;
    this.states = jobs.map((job) => ({
      job,
      nextFire: null,
      timer: null,
      running: false,
      isReboot: job.schedule.trim().toLowerCase() === "@reboot",
    }));

    if (options.installSignalHandlers) this.installSignalHandlers();
  }

  /**
   * Subscribe to every lifecycle event (in addition to the constructor's `onEvent`). Returns an
   * unsubscribe function. Used by the local dashboard to fan events out to many SSE clients without
   * disturbing the scheduler. A listener that throws is isolated — it can't break the loop.
   */
  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Register a hook to run once, after {@link stop} has drained in-flight runs — e.g. to close a
   * dashboard server so `engine.stop()` tears everything down together. Hooks are awaited.
   */
  onStop(hook: () => void | Promise<void>): this {
    this.closeHooks.push(hook);
    return this;
  }

  /** Deliver an event to every listener, isolating each so one bad listener can't stall the loop. */
  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener (e.g. a dead SSE connection) must never break scheduling.
      }
    }
  }

  /** Begin scheduling. Idempotent — a second call is a no-op. */
  start(): this {
    if (this.started) return this;
    this.started = true;
    this.stopped = false;
    this.startedAtMs = this.clock.now();
    this.emit({ type: "engine-start", jobs: this.states.length, at: this.startedAtMs });

    for (const state of this.states) {
      if (state.isReboot) {
        // `@reboot` runs once at startup and is never rescheduled.
        this.launch(state);
      } else {
        this.scheduleNext(state);
      }
    }
    return this;
  }

  /**
   * Stop scheduling and wait for in-flight runs to settle. After this resolves no further handlers
   * will start. Safe to call from a signal handler.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      await Promise.allSettled([...this.inFlight]);
      return;
    }
    this.stopped = true;
    for (const state of this.states) {
      if (state.timer !== null) {
        this.clock.clearTimeout(state.timer);
        state.timer = null;
      }
    }
    this.signalCleanup?.();
    this.signalCleanup = null;
    await Promise.allSettled([...this.inFlight]);
    // Tell subscribers we're done before tearing down anything they depend on (e.g. SSE clients
    // see `engine-stop`, then the dashboard server's close hook ends their connections).
    this.emit({ type: "engine-stop", at: this.clock.now() });
    for (const hook of this.closeHooks.splice(0)) {
      try {
        await hook();
      } catch {
        // A failing shutdown hook must not prevent the engine from stopping.
      }
    }
  }

  /** The run history, newest first (a copy — safe to keep). */
  runs(): RunRecord[] {
    return [...this.history].reverse();
  }

  /** History entries for one job, newest first. */
  runsFor(key: string): RunRecord[] {
    return this.runs().filter((r) => r.key === key);
  }

  /** Current scheduling state of every job, for the dev table. */
  snapshot(): JobSnapshot[] {
    return this.states.map((s) => ({
      key: s.job.key,
      schedule: s.job.schedule,
      timeZone: s.job.timeZone,
      ...(s.job.description !== undefined ? { description: s.job.description } : {}),
      nextFire: s.nextFire !== null ? new Date(s.nextFire) : null,
      running: s.running,
    }));
  }

  /** The jobs this engine manages (read-only view). */
  jobs(): readonly EngineJob[] {
    return this.states.map((s) => s.job);
  }

  /** Number of runs currently in flight. */
  get activeRuns(): number {
    return this.inFlight.size;
  }

  /** Epoch ms of the `start()` call, or null while the engine has never been started. */
  get startedAt(): number | null {
    return this.startedAtMs;
  }

  /** True between `start()` and `stop()`. */
  get running(): boolean {
    return this.started && !this.stopped;
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  private scheduleNext(state: JobState): void {
    if (this.stopped) return;
    const now = this.clock.now();
    let next: Date | null;
    try {
      next = nextOccurrence(state.job.schedule, { from: now, timeZone: state.job.timeZone });
    } catch {
      // An unschedulable expression (e.g. a typo that slipped past define-time validation) simply
      // never fires locally; leave nextFire null so it shows as "—" in the table.
      state.nextFire = null;
      return;
    }
    if (!next) {
      state.nextFire = null;
      return;
    }
    state.nextFire = next.getTime();
    const delay = Math.max(0, Math.min(state.nextFire - now, MAX_TIMER_MS));
    state.timer = this.clock.setTimeout(() => this.onDue(state), delay);
    this.emit({ type: "scheduled", key: state.job.key, at: state.nextFire });
  }

  private onDue(state: JobState): void {
    state.timer = null;
    if (this.stopped) return;
    const now = this.clock.now();

    // Woke early because the wait was clamped (very distant fire) — just re-arm the timer.
    if (state.nextFire !== null && now < state.nextFire) {
      const delay = Math.max(0, Math.min(state.nextFire - now, MAX_TIMER_MS));
      state.timer = this.clock.setTimeout(() => this.onDue(state), delay);
      return;
    }

    if (state.running && !state.job.allowConcurrentRuns) {
      this.emit({ type: "skipped", key: state.job.key, reason: "overlap", at: now });
      this.record({
        key: state.job.key,
        source: "local",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: "skipped",
        attempts: 0,
      });
    } else {
      this.launch(state);
    }
    // Keep the schedule ticking regardless of whether this fire ran or was skipped.
    this.scheduleNext(state);
  }

  /**
   * Run a job once, right now, by key — the local equivalent of "run now" in the cloud. Goes through
   * the exact same execution path as a scheduled fire (overlap protection, timeout, retry/backoff,
   * history + events), so a manual run shows up in the feed just like any other. Resolves with the
   * resulting {@link RunRecord}. Throws for an unknown key or after the engine has stopped.
   */
  async trigger(key: string): Promise<RunRecord> {
    if (this.stopped) throw new Error("cannot trigger a job on a stopped engine");
    const state = this.states.find((s) => s.job.key === key);
    if (!state) throw new Error(`unknown job '${key}'`);

    if (state.running && !state.job.allowConcurrentRuns) {
      const now = this.clock.now();
      const skipped: RunRecord = { key, source: "local", startedAt: now, finishedAt: now, durationMs: 0, status: "skipped", attempts: 0 };
      this.emit({ type: "skipped", key, reason: "overlap", at: now });
      this.record(skipped);
      return skipped;
    }
    return this.launch(state);
  }

  /**
   * The run history as newline-delimited JSON (NDJSON), oldest run first — one record per line, the
   * natural shape for piping to a file or another tool. No trailing newline.
   */
  toNdjson(): string {
    return this.history.map((r) => JSON.stringify(r)).join("\n");
  }

  /** Start an execution and track it so {@link stop} can await it. Resolves with the run's record. */
  private launch(state: JobState): Promise<RunRecord> {
    const promise = this.execute(state);
    const tracked = promise.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  // ── Execution with timeout + retry/backoff ──────────────────────────────────

  private async execute(state: JobState): Promise<RunRecord> {
    const job = state.job;
    state.running = true;
    const startedAt = this.clock.now();
    const maxRetries = Math.max(0, job.maxRetries ?? 0);

    let attempt = 0;
    let status: RunStatus = "error";
    let error: string | undefined;
    let result: unknown;

    while (!this.stopped) {
      attempt++;
      this.emit({ type: "fire", key: job.key, attempt, at: this.clock.now() });
      try {
        result = await this.runOnce(job);
        status = "success";
        this.emit({ type: "success", key: job.key, durationMs: this.clock.now() - startedAt, attempts: attempt, result, at: this.clock.now() });
        error = undefined;
        break;
      } catch (err) {
        const timedOut = err instanceof RunTimeoutError;
        status = timedOut ? "timed_out" : "error";
        error = err instanceof Error ? err.message : String(err);
        const willRetry = attempt <= maxRetries && !this.stopped;
        const at = this.clock.now();
        if (timedOut) {
          this.emit({ type: "timeout", key: job.key, durationMs: at - startedAt, attempt, willRetry, at });
        } else {
          this.emit({ type: "error", key: job.key, durationMs: at - startedAt, attempt, willRetry, error, at });
        }
        if (!willRetry) break;
        const delayMs = this.backoff(attempt);
        this.emit({ type: "retry", key: job.key, attempt: attempt + 1, delayMs, at });
        await this.sleep(delayMs);
      }
    }

    const finishedAt = this.clock.now();
    const record: RunRecord = {
      key: job.key,
      source: "local",
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      status,
      attempts: attempt,
      ...(error !== undefined ? { error } : {}),
      ...(status === "success" ? { result } : {}),
    };
    this.record(record);
    state.running = false;
    return record;
  }

  /** A single attempt: run the handler, racing it against the per-job timeout. */
  private runOnce(job: EngineJob): Promise<unknown> {
    const controller = new AbortController();
    const handlerPromise = this.runner(job.key, controller.signal);
    const timeoutMs = job.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return handlerPromise;

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new RunTimeoutError(job.key, timeoutMs));
      }, timeoutMs);
      handlerPromise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  private record(record: RunRecord): void {
    this.history.push(record);
    if (this.history.length > this.historyLimit) this.history.shift();
  }

  private installSignalHandlers(): void {
    const handler = (): void => {
      void this.stop().then(() => process.exit(0));
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    this.signalCleanup = () => {
      process.removeListener("SIGINT", handler);
      process.removeListener("SIGTERM", handler);
    };
  }
}
