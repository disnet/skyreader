// Sentry event scrubbing for the proxy.
//
// The backend has a thorough scrubber (`backend/src/observability/scrub.ts`);
// this is deliberately a smaller thing, matched to what this runtime actually
// holds. Two credentials pass through the proxy and neither may ever reach an
// error tracker:
//
//   - `X-Proxy-Secret`, on every authenticated call from the Worker.
//   - Feed URLs, which routinely carry an API key or token in the query string
//     (private RSS feeds, newsletter archives, Feedbin-style tokenised URLs).
//
// Whether @sentry/bun attaches request data at all under Bun.serve + Hono is
// unconfirmed — which is exactly why this exists. Attaching nothing costs a
// no-op; attaching a secret costs a leaked shared credential.
//
// Everything here is total and defensive: a scrubber that throws inside
// `beforeSend` would drop the event it was meant to sanitise.

const REDACTED = '[redacted]';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-proxy-secret',
  'x-api-key',
]);

const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|api[_-]?key|signature|auth)/i;
const URL_WITH_QUERY = /\bhttps?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi;
const AUTH_SCHEME_VALUE = /\b(Bearer|DPoP|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const INLINE_PAIR = /([A-Za-z0-9_.-]+)(\s*[=:]\s*)(["']?)([^\s,;&"']+)\3/g;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Redact the values of credential-shaped params, keeping the URL readable. */
export function scrubQueryString(queryString: string): string {
  const leading = queryString.startsWith('?') ? '?' : '';
  const params = new URLSearchParams(leading ? queryString.slice(1) : queryString);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (isSensitiveKey(key)) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? leading + params.toString() : queryString;
}

/** A URL with its query-string credentials redacted, if it has any. */
export function scrubUrl(url: string): string {
  const index = url.indexOf('?');
  if (index === -1) return url;
  return `${url.slice(0, index)}?${scrubQueryString(url.slice(index + 1))}`;
}

/** Redact tokenised URLs and inline credential-shaped values in free text. */
export function scrubText(value: string): string {
  return value
    .replace(URL_WITH_QUERY, (url) => scrubUrl(url))
    .replace(AUTH_SCHEME_VALUE, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(INLINE_PAIR, (match, key: string, separator: string, quote: string) =>
      isSensitiveKey(key) ? `${key}${separator}${quote}${REDACTED}${quote}` : match
    );
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, depth + 1));

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    record[key] = isSensitiveKey(key) ? REDACTED : scrubValue(record[key], depth + 1);
  }
  return record;
}

interface ScrubbableRequest {
  url?: string;
  headers?: Record<string, unknown>;
  query_string?: unknown;
  cookies?: unknown;
  data?: unknown;
}

/**
 * Strip credentials from a Sentry event in place. Returns the same event, or the
 * untouched event if anything at all goes wrong.
 *
 * Typed over `T` rather than over the SDK's `Event`: staying structurally loose
 * means an SDK type change can't turn a security control into a build error.
 */
export function scrubEvent<T>(event: T): T {
  try {
    const request = (event as { request?: ScrubbableRequest } | null)?.request;
    if (request?.headers) {
      for (const key of Object.keys(request.headers)) {
        const lower = key.toLowerCase();
        if (SENSITIVE_HEADERS.has(lower) || isSensitiveKey(lower)) {
          request.headers[key] = REDACTED;
        }
      }
    }

    if (typeof request?.url === 'string') request.url = scrubUrl(request.url);
    if (typeof request?.query_string === 'string') {
      request.query_string = scrubQueryString(request.query_string);
    }

    // Neither is ever useful in a proxy stack trace, and both carry credentials
    // by definition. Dropping beats redacting when there's nothing to lose.
    if (request) {
      delete request.cookies;
      delete request.data;
    }

    const scrubbable = event as {
      breadcrumbs?: { message?: unknown; data?: unknown }[];
      exception?: { values?: { value?: unknown }[] };
      extra?: unknown;
      message?: unknown;
    };
    for (const breadcrumb of scrubbable.breadcrumbs ?? []) {
      if (typeof breadcrumb.message === 'string')
        breadcrumb.message = scrubText(breadcrumb.message);
      // Assigned rather than called for its side effect: scrubValue can't redact a
      // top-level string or array in place, so discarding the result would make the
      // scrub a silent no-op for those shapes — the worst failure mode for a
      // security control that swallows its own exceptions.
      if (breadcrumb.data) breadcrumb.data = scrubValue(breadcrumb.data);
    }
    for (const exception of scrubbable.exception?.values ?? []) {
      if (typeof exception.value === 'string') exception.value = scrubText(exception.value);
    }
    if (scrubbable.extra) scrubbable.extra = scrubValue(scrubbable.extra);
    if (typeof scrubbable.message === 'string') scrubbable.message = scrubText(scrubbable.message);

    return event;
  } catch {
    return event;
  }
}
