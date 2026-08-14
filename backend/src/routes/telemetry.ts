import type { Env } from '../types';
import { checkRateLimit } from '../services/rate-limit';
import { log } from '../utils/logger';
import { reportMessage } from '../observability/sentry';

// Client-side error reporting, deliberately minimal.
//
// The gap this closes: when a deploy breaks the PWA shell for real users, we
// currently learn about it from a bug report. The gap it does NOT try to close is
// per-user telemetry — there is no session replay, no breadcrumb trail, no page
// analytics, and the client never talks to a third party. The browser posts here;
// this Worker decides what reaches the error tracker.
//
// Everything the client sends is treated as hostile: this endpoint is
// unauthenticated (an error on the login screen is exactly the kind we want), so
// every field is length-capped, the `kind` is an allowlist, and the URL is
// reduced to a path before it goes anywhere. The client samples before it sends
// (see frontend/src/lib/services/telemetry.ts); the rate limit here is the floor
// under a client that ignores its own sampling, not the primary control.

export const TELEMETRY_PATH = '/api/telemetry/error';

/** Refuse to even read a body larger than this — nothing legitimate is close. */
const MAX_BODY_BYTES = 16 * 1024;

const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_CHARS = 2000;
const MAX_NAME_CHARS = 100;
const MAX_URL_CHARS = 200;
const MAX_VERSION_CHARS = 64;

/**
 * What kind of failure the client is reporting. A closed set, because this is a
 * Sentry tag and a log facet: an open one would let a client mint unbounded
 * values in both.
 */
const KINDS = new Set([
  // SvelteKit's handleError — an error during navigation or rendering.
  'render',
  // window.onerror — an uncaught exception anywhere else.
  'uncaught',
  // unhandledrejection — a promise nobody caught.
  'rejection',
  // The stale-chunk reload guard tripped twice: recovery itself failed, which is
  // the "a deploy bricked the PWA" signal. Never sampled away by the client.
  'preload_recovery_failed',
]);

interface ClientErrorReport {
  kind: string;
  name: string;
  message: string;
  stack?: string;
  /** The frontend build (`$app/environment`'s version = the deploy's SHA). */
  appVersion?: string;
  /** Path only — the client strips the query string, and so do we. */
  path?: string;
  /** Client-side sampling rate, so a count here can be scaled back up. */
  sampleRate?: number;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Keep the path, drop everything that could carry a credential or an identifier:
 * query strings (share tokens, OAuth params), fragments, and the origin.
 */
function safePath(value: unknown): string | undefined {
  const raw = text(value, MAX_URL_CHARS * 4);
  if (!raw) return undefined;
  try {
    return text(new URL(raw, 'https://skyreader.app').pathname, MAX_URL_CHARS);
  } catch {
    return text(raw.split(/[?#]/)[0], MAX_URL_CHARS);
  }
}

function parseReport(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;

  const kind = typeof input.kind === 'string' && KINDS.has(input.kind) ? input.kind : null;
  if (!kind) return null;

  const message = text(input.message, MAX_MESSAGE_CHARS);
  if (!message) return null;

  const sampleRate =
    typeof input.sampleRate === 'number' && input.sampleRate > 0 && input.sampleRate <= 1
      ? input.sampleRate
      : undefined;

  return {
    kind,
    name: text(input.name, MAX_NAME_CHARS) ?? 'Error',
    message,
    stack: text(input.stack, MAX_STACK_CHARS),
    appVersion: text(input.appVersion, MAX_VERSION_CHARS),
    path: safePath(input.path),
    sampleRate,
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Accept one client error report.
 *
 * Answers before it does any work whenever it can: a browser is waiting on this
 * during a page that is already broken, so nothing here is allowed to be slow or
 * to fail loudly. Every outcome is a small JSON body the client ignores.
 */
export async function handleTelemetryError(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

  // Keyed by IP, never by DID: this route is answered before session resolution
  // (see src/index.ts), so there is no session to key on — which is the point.
  // An error on the login screen has no DID either, and that's a report worth
  // having.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimit = await checkRateLimit(env, `telemetry:${ip}`, TELEMETRY_PATH);
  if (!rateLimit.allowed) {
    // 429 without Retry-After on purpose: a client in an error loop should drop
    // the report, not schedule it. The frontend reporter never retries.
    return json({ error: 'Rate limit exceeded' }, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const report = parseReport(body);
  if (!report) return json({ error: 'Invalid report' }, 400);

  // Workers Logs gets the full picture (queryable by `event = client_error`);
  // Sentry gets the grouped, notifiable version.
  log.warn('client_error', {
    kind: report.kind,
    errorName: report.name,
    errorMessage: report.message,
    appVersion: report.appVersion,
    path: report.path,
    sampleRate: report.sampleRate,
  });

  reportMessage(`[client] ${report.name}: ${report.message}`, {
    level: 'error',
    // Group by kind + name + message rather than by the stack: the stack belongs
    // to a client bundle this Sentry project has no source maps for, so letting
    // the SDK group on it would scatter one bug across many issues.
    fingerprint: ['client', report.kind, report.name, report.message],
    tags: {
      source: 'client',
      kind: report.kind,
      ...(report.appVersion ? { appVersion: report.appVersion } : {}),
    },
    extra: {
      stack: report.stack,
      path: report.path,
      sampleRate: report.sampleRate,
      userAgent: request.headers.get('User-Agent')?.slice(0, 200),
    },
  });

  return new Response(null, { status: 204 });
}
