import { describe, expect, it } from 'bun:test';
import { Semaphore, OverloadError } from './semaphore';

// A deferred promise whose resolution we control, to hold permits open.
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Semaphore', () => {
  it('admits up to maxConcurrent immediately', async () => {
    const sem = new Semaphore(2, 5);
    await sem.acquire();
    await sem.acquire();
    expect(sem.inUse).toBe(2);
    expect(sem.queued).toBe(0);
  });

  it('queues callers past maxConcurrent and hands them permits on release', async () => {
    const sem = new Semaphore(1, 5);
    await sem.acquire();

    let admitted = false;
    const waiting = sem.acquire().then(() => {
      admitted = true;
    });

    // Still parked while the single permit is held.
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(sem.queued).toBe(1);

    sem.release();
    await waiting;
    expect(admitted).toBe(true);
    expect(sem.inUse).toBe(1); // permit passed straight to the waiter
  });

  it('sheds load with OverloadError once the queue is full', async () => {
    const sem = new Semaphore(1, 1);
    await sem.acquire(); // holds the only permit
    const queued = sem.acquire(); // fills the single queue slot

    await expect(sem.acquire()).rejects.toBeInstanceOf(OverloadError);

    // Drain so the queued waiter doesn't dangle.
    sem.release();
    await queued;
  });

  // The queue bounds how many callers wait, not how long. On a request path an
  // unbounded wait outlives the server's socket timeout and dies as a bare edge
  // error, which is the failure a 503 exists to replace.
  it('sheds a waiter whose wait outlasts its deadline', async () => {
    const sem = new Semaphore(1, 5);
    await sem.acquire(); // holds the only permit, and never releases it

    await expect(sem.acquire(20)).rejects.toBeInstanceOf(OverloadError);
    expect(sem.queued).toBe(0); // the timed-out waiter left the queue
  });

  it('keeps waiting when a permit arrives before the deadline', async () => {
    const sem = new Semaphore(1, 5);
    await sem.acquire();

    const queued = sem.acquire(1000);
    sem.release();
    await queued; // admitted, not shed
    expect(sem.inUse).toBe(1);
  });

  // A permit handed to a waiter that already gave up would be lost for good:
  // `available` stays decremented across the handoff.
  it('does not lose a permit when release() meets a timed-out waiter', async () => {
    const sem = new Semaphore(1, 5);
    await sem.acquire();

    await expect(sem.acquire(20)).rejects.toBeInstanceOf(OverloadError);
    sem.release();

    expect(sem.inUse).toBe(0);
    await sem.acquire(); // the permit is back in the pool
    expect(sem.inUse).toBe(1);
  });

  it('run() releases the permit on success and on throw', async () => {
    const sem = new Semaphore(1, 1);

    await sem.run(async () => 'ok');
    expect(sem.inUse).toBe(0);

    await expect(
      sem.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(sem.inUse).toBe(0); // released despite the throw
  });

  it('serializes work so no more than maxConcurrent run at once', async () => {
    const sem = new Semaphore(2, 10);
    let active = 0;
    let peak = 0;
    const gate = defer();

    const tasks = Array.from({ length: 5 }, () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
      })
    );

    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);
    gate.resolve();
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(sem.inUse).toBe(0);
  });

  it('clamps a non-positive concurrency to one permit (never deadlocks)', async () => {
    const sem = new Semaphore(0, 1);
    await sem.acquire();
    expect(sem.inUse).toBe(1);
  });
});
