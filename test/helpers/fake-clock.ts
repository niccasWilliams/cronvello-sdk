/**
 * A deterministic virtual clock for the local engine. It satisfies the engine's `EngineClock` seam
 * (`now` / `setTimeout` / `clearTimeout`) but, instead of waiting on real time, fires timers when the
 * test explicitly advances virtual time — flushing the microtask queue between each so async handler
 * chains (and any timers they schedule, like retry backoff) make progress before the next fire.
 *
 * This is what makes the scheduler tests fast and free of wall-clock flakiness: a virtual day passes
 * in microseconds and the ordering is fully reproducible.
 */

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
  cleared: boolean;
}

/** Let queued microtasks (and a macrotask turn) drain so awaited promises settle. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeClock {
  private t: number;
  private timers: FakeTimer[] = [];
  private seq = 0;

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn, cleared: false });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const timer = this.timers.find((x) => x.id === handle);
    if (timer) timer.cleared = true;
  }

  /** Outstanding (uncleared) timer count — handy for asserting a clean shutdown. */
  pending(): number {
    return this.timers.filter((x) => !x.cleared).length;
  }

  /** Advance virtual time by `ms`, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.t + ms);
  }

  /** Advance virtual time to an absolute instant, firing every timer due at or before it. */
  async advanceTo(target: number): Promise<void> {
    // Re-scan after every fire: a timer's callback may register new timers (backoff, reschedule).
    for (let guard = 0; guard < 100_000; guard++) {
      const due = this.timers
        .filter((x) => !x.cleared && x.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
      await flushMicrotasks();
    }
    this.t = target;
    await flushMicrotasks();
  }
}

/** A promise whose resolution the test controls — for keeping a handler "in flight" across fires. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
