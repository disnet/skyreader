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
