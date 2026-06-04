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

export class Semaphore {
  private available: number;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  // Waiters resolve when a permit is handed directly to them by release().
  private readonly waiters: Array<() => void> = [];

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
   */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    if (this.waiters.length >= this.maxQueue) {
      throw new OverloadError();
    }
    // The permit is handed to us directly by release(); `available` stays
    // decremented across the handoff (never returned to the pool in between).
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Return a permit: hand it to the oldest waiter, or back to the pool. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }

  /** Run `fn` while holding a permit, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
