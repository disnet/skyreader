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

// --- Free text -------------------------------------------------------------
//
// Breadcrumbs, exception messages and log-ish strings carry credentials inline,
// where there is no key to match on: a tokenized URL, an `Authorization: Bearer
// …` echoed into an error, a `code_verifier=…` pasted into a message. These
// three patterns cover what this codebase actually produces.

// A URL with a query string, anywhere inside a longer string.
const URL_WITH_QUERY = /\bhttps?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi;
// `Bearer <token>` / `DPoP <proof>` / `Basic <creds>`.
const AUTH_SCHEME_VALUE = /\b(Bearer|DPoP|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// `key=value` / `key: value` pairs, so the key can be tested with the same rule
// used for structured fields.
const INLINE_PAIR = /([A-Za-z0-9_.-]+)(\s*[=:]\s*)(["']?)([^\s,;&"']+)\3/g;

/**
 * Redact credentials embedded in an arbitrary string. Conservative: it rewrites
 * only what matches a credential shape, so ordinary prose survives intact.
 */
export function scrubText(text: string): string {
  return (
    text
      .replace(URL_WITH_QUERY, (url) => {
        const [base, query] = splitOnce(url, '?');
        return `${base}?${scrubQueryString(query)}`;
      })
      .replace(AUTH_SCHEME_VALUE, (_match, scheme: string) => `${scheme} ${REDACTED}`)
      .replace(INLINE_PAIR, (match, key: string, separator: string, quote: string) =>
        isSensitiveKey(key) ? `${key}${separator}${quote}${REDACTED}${quote}` : match
      )
      // `Authorization: Bearer <jwt>` matches two rules in a row and comes out as
      // `[redacted] [redacted]`. Same safety, less noise.
      .replace(/(?:\[redacted\]\s+)+\[redacted\]/g, REDACTED)
  );
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
  // A non-sensitive key can still hold a sensitive string ("url", "message").
  if (typeof value === 'string') return scrubText(value);
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
  return scrubText(data);
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

  // Assigned rather than called for their side effect: scrubValue can't redact a
  // top-level string or array in place, so discarding the result would make the
  // scrub a silent no-op for those shapes — the worst failure mode for a control
  // whose caller swallows exceptions.
  if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;
  if (event.tags) event.tags = scrubValue(event.tags) as typeof event.tags;

  // Breadcrumbs are the widest unstructured channel: whatever a call site logged
  // before the throw rides along verbatim. The Console integration is disabled
  // for exactly that reason (see ./sentry.ts), but anything the SDK or a future
  // `addBreadcrumb()` adds still passes through here.
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubText(breadcrumb.message);
    if (breadcrumb.data) breadcrumb.data = scrubValue(breadcrumb.data) as typeof breadcrumb.data;
  }

  // An exception's own message is free text and routinely quotes the URL that
  // failed — including its query string.
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === 'string') exception.value = scrubText(exception.value);
  }
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);

  return event;
}
