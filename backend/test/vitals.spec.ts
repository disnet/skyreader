import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { bucketFor, routeKey, pruneVitals, VITALS_RETENTION_DAYS } from '../src/routes/vitals';

// Field vitals are aggregate-only: a report increments histogram buckets and is
// otherwise forgotten. These pin that boundary — what lands, what's refused, and
// that nothing a client sends can mint new row keys.

const post = (body: unknown, ip = '203.0.113.7') =>
  SELF.fetch('http://localhost/api/telemetry/vitals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

interface Row {
  day: string;
  metric: string;
  route: string;
  app_version: string;
  bucket_le: number;
  count: number;
}

async function rows(): Promise<Row[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM client_vitals ORDER BY metric, route, bucket_le'
  ).all<Row>();
  return result.results;
}

describe('POST /api/telemetry/vitals', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM client_vitals').run();
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it('counts each metric into its bucket, without a session', async () => {
    const response = await post({
      route: '/feeds',
      appVersion: 'abc123',
      inp: 180,
      cls: 0.04,
      blocking: 0,
    });
    expect(response.status).toBe(204);

    const stored = await rows();
    expect(
      stored.map(({ metric, route, app_version, bucket_le, count }) => ({
        metric,
        route,
        app_version,
        bucket_le,
        count,
      }))
    ).toEqual([
      { metric: 'blocking', route: '/feeds', app_version: 'abc123', bucket_le: 16, count: 1 },
      { metric: 'cls', route: '/feeds', app_version: 'abc123', bucket_le: 0.05, count: 1 },
      { metric: 'inp', route: '/feeds', app_version: 'abc123', bucket_le: 200, count: 1 },
    ]);
    expect(stored[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('increments the same bucket rather than storing reports', async () => {
    await post({ route: '/home', appVersion: 'v1', inp: 90 });
    await post({ route: '/home', appVersion: 'v1', inp: 95 });

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ metric: 'inp', bucket_le: 100, count: 2 });
  });

  it('reduces routes and versions so a client cannot mint row keys', async () => {
    await post({ route: '/rooms/[id]', appVersion: 'v1', inp: 10 });
    await post({ route: '/made-up/path', appVersion: 'v1', inp: 10 });
    await post({ route: '/feeds', appVersion: 'x'.repeat(200), inp: 10 });
    await post({ route: { nope: true }, appVersion: '<script>', inp: 10 });

    const keys = (await rows()).map((r) => `${r.route}|${r.app_version}`).sort();
    expect(keys).toEqual(['/feeds|unknown', '/rooms|v1', 'other|unknown', 'other|v1']);
  });

  it('drops values that are not plausible measurements', async () => {
    const response = await post({
      route: '/feeds',
      appVersion: 'v1',
      inp: -5,
      cls: Number.MAX_VALUE,
      blocking: 'slow',
    });
    expect(response.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses oversized and non-JSON bodies', async () => {
    expect((await post('not json')).status).toBe(400);
    const big = await SELF.fetch('http://localhost/api/telemetry/vitals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' },
      body: '{}',
    });
    expect(big.status).toBe(413);
  });

  it('rate limits by IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push(
        (await post({ route: '/feeds', appVersion: 'v1', inp: 10 }, '198.51.100.9')).status
      );
    }
    expect(statuses.slice(0, 20).every((s) => s === 204)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('vitals helpers', () => {
  it('buckets by upper bound, with an overflow bucket', () => {
    expect(bucketFor('inp', 0)).toBe(16);
    expect(bucketFor('inp', 200)).toBe(200);
    expect(bucketFor('inp', 201)).toBe(300);
    expect(bucketFor('inp', 60_000)).toBe(1e9);
    expect(bucketFor('cls', 0.1)).toBe(0.1);
    expect(bucketFor('cls', 3)).toBe(1e9);
  });

  it('keeps only allowlisted first segments of a route', () => {
    expect(routeKey('/')).toBe('/');
    expect(routeKey('/feeds')).toBe('/feeds');
    expect(routeKey('/linkblog/[handle]')).toBe('/linkblog');
    expect(routeKey('/admin')).toBe('other');
    expect(routeKey(undefined)).toBe('other');
    expect(routeKey('other')).toBe('other');
    expect(routeKey('feeds')).toBe('other');
  });

  it('prunes days past retention', async () => {
    await env.DB.prepare('DELETE FROM client_vitals').run();
    const now = Date.UTC(2026, 9, 15);
    const old = new Date(now - (VITALS_RETENTION_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    const recent = new Date(now - 86_400_000).toISOString().slice(0, 10);
    for (const day of [old, recent]) {
      await env.DB.prepare(
        `INSERT INTO client_vitals (day, metric, route, app_version, bucket_le, count)
         VALUES (?, 'inp', '/feeds', 'v1', 100, 1)`
      )
        .bind(day)
        .run();
    }
    await pruneVitals(env, now);
    const left = await env.DB.prepare('SELECT day FROM client_vitals').all<{ day: string }>();
    expect(left.results.map((r) => r.day)).toEqual([recent]);
  });
});
