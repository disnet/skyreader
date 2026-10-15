import type { Env } from '../types';
import { checkRateLimit } from '../services/rate-limit';

// Field responsiveness, in aggregate. The one question: does Skyreader feel crisp
// on readers' real devices, and did a deploy change that?
//
// The runbook's non-goal still holds — no per-user telemetry, no page views, no
// session replay, no third-party SDK. A report is three numbers (worst
// interaction delay, layout shift, main-thread blocking time) for one page view,
// a route pattern and the build. Nothing that identifies a reader arrives, and
// nothing about one report is stored: each number only increments a counter in a
// daily histogram (`client_vitals`, migration 0092), and percentiles are read
// back from the buckets. See docs/RUNBOOK.md, "Field vitals".
//
// Like /api/telemetry/error, this is answered before session resolution and
// treats every field as hostile: the route is reduced to an allowlisted first
// segment and the version to a short token, so a client can't mint unbounded
// rows. The client samples before it sends (frontend/src/lib/services/vitals.ts).

export const VITALS_PATH = '/api/telemetry/vitals';

const MAX_BODY_BYTES = 2 * 1024;

/** How long the daily histograms are kept. */
export const VITALS_RETENTION_DAYS = 90;

/**
 * Bucket upper bounds. A value lands in the first bucket it fits under; the
 * last bound catches everything past the scale. The bound itself is stored, so
 * a reader of the table needs no copy of this list.
 */
const MS_BOUNDS = [16, 32, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 2000, 5000, 1e9];
const CLS_BOUNDS = [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 1e9];

const METRICS = {
  // Interaction to Next Paint: the slowest tap/click/key-to-paint in the view.
  inp: MS_BOUNDS,
  // Cumulative Layout Shift: the largest burst of unexpected movement.
  cls: CLS_BOUNDS,
  // Main-thread blocking: the sum of every long task's time past 50ms.
  blocking: MS_BOUNDS,
} as const;

type Metric = keyof typeof METRICS;

/**
 * First path segments the frontend has. Anything else — a typo, a hostile
 * client, a route added since — is 'other', never a new row key.
 */
const ROUTES = new Set([
  '/',
  '/home',
  '/feeds',
  '/saved',
  '/linkblog',
  '/highlights',
  '/rooms',
  '/discover',
  '/sources',
  '/following',
  '/channels',
  '/daily',
  '/settings',
  '/search',
  '/subscribe',
  '/save',
]);

export function bucketFor(metric: Metric, value: number): number {
  const bounds = METRICS[metric];
  return bounds.find((bound) => value <= bound) ?? bounds[bounds.length - 1];
}

/** A route pattern (SvelteKit's `route.id`), reduced to its allowlisted first segment. */
export function routeKey(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return 'other';
  const first = `/${value.split('/')[1] ?? ''}`;
  return ROUTES.has(first) ? first : 'other';
}

/** The build (a deploy SHA, or a short version string); anything odd is 'unknown'. */
function versionKey(value: unknown): string {
  return typeof value === 'string' && /^[0-9A-Za-z._-]{1,40}$/.test(value) ? value : 'unknown';
}

function metricValue(metric: Metric, value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  // Past these, a value is a broken clock or a hostile client, not a slow page.
  const ceiling = metric === 'cls' ? 100 : 10 * 60 * 1000;
  return value <= ceiling ? value : null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** UTC calendar day, the histograms' grain. */
function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Accept one page view's vitals and count them into today's histograms. */
export async function handleVitals(
  request: Request,
  env: Env,
  now = Date.now()
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

  // By IP, never by DID: there's no session here, by design (see src/index.ts).
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimit = await checkRateLimit(env, `vitals:${ip}`, VITALS_PATH);
  if (!rateLimit.allowed) return json({ error: 'Rate limit exceeded' }, 429);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid report' }, 400);
  const input = body as Record<string, unknown>;

  const route = routeKey(input.route);
  const version = versionKey(input.appVersion);
  const day = dayOf(now);

  const writes = (Object.keys(METRICS) as Metric[]).flatMap((metric) => {
    const value = metricValue(metric, input[metric]);
    if (value === null) return [];
    return [
      env.DB.prepare(
        `INSERT INTO client_vitals (day, metric, route, app_version, bucket_le, count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (day, metric, route, app_version, bucket_le)
         DO UPDATE SET count = count + 1`
      ).bind(day, metric, route, version, bucketFor(metric, value)),
    ];
  });
  if (writes.length === 0) return json({ error: 'Invalid report' }, 400);

  await env.DB.batch(writes);
  return new Response(null, { status: 204 });
}

/** Drop days past retention. Run from the hourly cron. */
export async function pruneVitals(env: Env, now = Date.now()): Promise<void> {
  const cutoff = dayOf(now - VITALS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await env.DB.prepare('DELETE FROM client_vitals WHERE day < ?').bind(cutoff).run();
}
