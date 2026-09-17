/**
 * Bounded-concurrency gate with load shedding.
 *
 * `/extract` is the proxy's heaviest request: it fetches up to a 10 MB HTML
 * document and builds a full linkedom DOM (Defuddle), which costs several times
 * the raw bytes in memory. Per-URL coalescing collapses *duplicate* extractions,
 * but nothing bounds the number of *distinct* heavy extractions in flight — on
 * the single 512 MB machine that's the realistic OOM path. This caps concurrent
 * work and, once a bounded queue fills, sheds load (OverloadError → 503) instead
 * of piling up unbounded promises.
 */

export class OverloadError extends Error {
  constructor(message = 'Overloaded: capacity reached') {
    super(message);
    this.name = 'OverloadError';
  }
}

interface Waiter {
  /** Hands the permit over (and cancels the wait deadline, if any). */
  admit: () => void;
  /** Set once the waiter has been admitted or has given up. */
  settled: boolean;
}

export class Semaphore {
  private available: number;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  // Waiters resolve when a permit is handed directly to them by release().
  private readonly waiters: Waiter[] = [];

  constructor(maxConcurrent: number, maxQueue: number) {
    // A zero/negative concurrency would deadlock; clamp to at least one permit.
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    this.maxQueue = Math.max(0, Math.floor(maxQueue));
    this.available = this.maxConcurrent;
  }

  /** Permits currently held (in use), including those handed to woken waiters. */
  get inUse(): number {
    return this.maxConcurrent - this.available;
  }

  /** Callers parked waiting for a permit. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Take a permit. Resolves immediately when one is free; otherwise parks in the
   * waiter queue. Rejects with OverloadError when the queue is already full, so
   * the caller can shed load rather than wait unbounded.
   *
   * `timeoutMs` bounds the wait itself. The queue caps how many callers may
   * wait, not how long any of them waits: with every permit held by slow work, a
   * caller at the back of a full queue can sit for the sum of everything ahead of
   * it. On a request path that is a request nobody answers — it outlives the
   * server's socket timeout and dies as a bare gateway error. Shedding on a
   * deadline turns that into a 503 the caller can act on.
   */
  async acquire(timeoutMs?: number): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    if (this.waiters.length >= this.maxQueue) {
      throw new OverloadError();
    }
    // The permit is handed to us directly by release(); `available` stays
    // decremented across the handoff (never returned to the pool in between).
    const waiter: Waiter = { admit: () => {}, settled: false };
    this.waiters.push(waiter);
    await new Promise<void>((resolve, reject) => {
      if (timeoutMs === undefined) {
        waiter.admit = resolve;
        return;
      }
      const timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(new OverloadError(`Overloaded: no capacity within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      waiter.admit = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Return a permit: hand it to the oldest waiter still waiting, or back to the
   * pool. Waiters that timed out are skipped (they hold no permit), so a permit
   * is never handed into the void.
   */
  release(): void {
    for (;;) {
      const next = this.waiters.shift();
      if (!next) {
        this.available++;
        return;
      }
      if (next.settled) continue;
      next.settled = true;
      next.admit();
      return;
    }
  }

  /** Run `fn` while holding a permit, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
