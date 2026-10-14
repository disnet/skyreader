import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRateLimit, cleanupRateLimits } from '../src/services/rate-limit';
import type { Env } from '../src/types';

const DID = 'did:plc:ratelimited';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function insert(endpoint: string, windowStart: number, count = 1) {
  await env.DB.prepare(
    'INSERT INTO rate_limits (did, endpoint, window_start, count) VALUES (?, ?, ?, ?)'
  )
    .bind(DID, endpoint, windowStart, count)
    .run();
}

async function remaining(): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT endpoint FROM rate_limits WHERE did = ? ORDER BY 1')
    .bind(DID)
    .all<{ endpoint: string }>();
  return rows.results.map((r) => r.endpoint);
}

describe('cleanupRateLimits', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it('keeps a row until its own window has closed', async () => {
    const now = Date.now();
    // A 1-minute window that closed a while ago, and one still open.
    await insert('/api/extract', now - 10 * MINUTE);
    await insert('/api/saved', now - 30_000);
    // A 1-hour window 40 minutes in: still counting.
    await insert('/api/sync/subscriptions', now - 40 * MINUTE);
    // A 5-minute window 4 minutes in, and one that closed 10 minutes ago.
    await insert('/api/sync/full', now - 4 * MINUTE);
    await insert('/api/sync/full', now - 15 * MINUTE);
    // An hour window from yesterday.
    await insert('/api/sync/subscriptions', now - 25 * HOUR);

    const { deleted } = await cleanupRateLimits(env as unknown as Env);

    expect(deleted).toBe(3);
    expect(await remaining()).toEqual(['/api/saved', '/api/sync/full', '/api/sync/subscriptions']);
  });

  it('lets an hourly limit hold across sweeps', async () => {
    const e = env as unknown as Env;
    const path = '/api/sync/subscriptions';
    const topOfHour = Math.floor(Date.now() / HOUR) * HOUR;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(topOfHour + MINUTE);
      for (let i = 0; i < 6; i++) expect((await checkRateLimit(e, DID, path)).allowed).toBe(true);

      // Half an hour on, after the minutely sweep has run many times.
      vi.setSystemTime(topOfHour + 30 * MINUTE);
      await cleanupRateLimits(e);

      expect((await checkRateLimit(e, DID, path)).allowed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
