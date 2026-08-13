import type { Event } from '@sentry/cloudflare';

// Sentry event scrubbing. Runs in `beforeSend` (see ./sentry.ts) so nothing
// leaves the Worker with a credential attached.
//
// What we keep on purpose: DIDs. They're public identifiers and the single most
// useful correlation key when chasing "which user hit this". What we strip:
// anything that could be replayed — OAuth codes/tokens, DPoP proofs, cookies,
// session ids, and our own shared secrets.

const REDACTED = '[redacted]';

// Matched case-insensitively against header names.
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'dpop',
  'x-proxy-secret',
  'x-health-secret',
  'x-api-key',
]);

// Matched against query-string params and body keys. Broad on purpose: a false
// positive costs one redacted debugging field, a false negative leaks a token.
const SENSITIVE_KEY =
  /(token|secret|password|passphrase|authorization|cookie|dpop|private[_-]?key|client[_-]?assertion|code[_-]?verifier|session[_-]?id|jwk|signature)/i;

// Single-use OAuth credentials whose names don't match the pattern above.
const SENSITIVE_PARAMS = new Set(['code', 'state', 'id_token']);

const MAX_DEPTH = 6;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_PARAMS.has(lower) || SENSITIVE_KEY.test(lower);
}

function scrubHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower) || SENSITIVE_KEY.test(lower)) {
      headers[key] = REDACTED;
    }
  }
  return headers;
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function scrubQueryString(queryString: string): string {
  // URLSearchParams round-trips both `a=1&b=2` and `?a=1&b=2` shapes.
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

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1));
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    record[key] = isSensitiveKey(key) ? REDACTED : scrubValue(record[key], depth + 1);
  }
  return record;
}

// Request bodies reach Sentry as either a parsed object or the raw string. Handle
// both so a JSON or form-encoded token payload can't slip through as text.
function scrubBody(data: unknown): unknown {
  if (typeof data !== 'string') return scrubValue(data);

  const trimmed = data.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(scrubValue(JSON.parse(trimmed)));
    } catch {
      // Not actually JSON — fall through to the form-encoded attempt.
    }
  }
  if (trimmed.includes('=')) return scrubQueryString(trimmed);
  return data;
}

/**
 * Strip credentials from a Sentry event in place, returning the same event.
 */
export function scrubEvent<T extends Event>(event: T): T {
  const request = event.request;
  if (request) {
    if (request.headers) scrubHeaders(request.headers as Record<string, unknown>);
    // The SDK usually splits the query into `query_string`, but not always — an
    // OAuth callback URL carries the single-use `code` right in `url`.
    if (typeof request.url === 'string' && request.url.includes('?')) {
      const [path, query] = splitOnce(request.url, '?');
      request.url = `${path}?${scrubQueryString(query)}`;
    }
    // Cookies are never useful in a stack trace and always carry the session.
    delete request.cookies;
    if (typeof request.query_string === 'string') {
      request.query_string = scrubQueryString(request.query_string);
    } else if (request.query_string) {
      request.query_string = scrubValue(request.query_string) as typeof request.query_string;
    }
    if (request.data !== undefined) request.data = scrubBody(request.data);
  }

  if (event.extra) scrubValue(event.extra);
  if (event.contexts) scrubValue(event.contexts);
  if (event.tags) scrubValue(event.tags);

  return event;
}
