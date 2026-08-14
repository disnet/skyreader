import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request (and per-cron-run, per-poll-cycle) context, carried in
// AsyncLocalStorage rather than threaded through every function signature.
//
// Why ALS: the useful correlation key is the request id, and the places that
// want it — a log line in a service, the outbound header on a feed-proxy call,
// a Sentry tag inside `reportError()` — are three or four call frames below the
// handler that minted it. Threading a parameter through all of them would touch
// every route and service for one field. `nodejs_als` is already enabled for
// @sentry/cloudflare (see wrangler.toml), so this costs nothing new.
//
// Nothing in here is required for correctness: every reader treats a missing
// store as "no id", so code paths outside a context (module init, tests calling
// a handler directly) work unchanged.

export interface RequestContext {
  /** Correlation id. Present on every log line and Sentry event from this task. */
  requestId: string;
  /** Route class, not raw path — see `classifyRoute()`. */
  route?: string;
  method?: string;
  /** Set once the session resolves. DIDs are public identifiers; keeping one is
   *  what turns "an error happened" into "this user hit it". */
  did?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` visible to everything it awaits. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Attach the DID to the in-flight context once the session is known. */
export function setContextDid(did: string): void {
  const context = storage.getStore();
  if (context) context.did = did;
}

/**
 * Collapse a pathname to a route class so logs group by endpoint instead of by
 * identifier. `/api/linkblog/share/3labc…` and `/api/linkblog/share/3lxyz…` are
 * the same route and must aggregate as one.
 *
 * Deliberately a small allowlist of the prefix-matched routes in index.ts plus a
 * generic guard: anything that reaches the default branch is a 404, and 404s on
 * arbitrary paths must not mint unbounded distinct route values.
 */
export function classifyRoute(pathname: string): string {
  const dynamicPrefixes = [
    '/api/linkblog/share/',
    '/api/linkblog/resolve/',
    '/api/subscriptions/',
    '/api/saved/by-guid/',
    '/api/saved/',
    '/api/integrations/margin/notes/',
    '/api/channels/',
    '/.well-known/lexicons/',
  ];
  for (const prefix of dynamicPrefixes) {
    if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
      // Keep the verb-ish suffixes index.ts routes on (…/activate, …/park) —
      // they're distinct endpoints, not identifiers.
      const [, next] = pathname.slice(prefix.length).split('/');
      return `${prefix}:id${next ? `/${next}` : ''}`;
    }
  }
  // Cap the cardinality of everything else. Real routes in this app are at most
  // four segments deep; anything longer is a probe or a typo.
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 4) return '/' + segments.slice(0, 4).join('/') + '/…';
  return pathname;
}
