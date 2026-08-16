import { SELF } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '../src/utils/logger';
import { classifyRoute, getRequestId, runWithRequestContext } from '../src/utils/request-context';

// Phase 1 of the observability plan: every request carries an id, every log line
// is a queryable object rather than a sentence, and the id reaches outbound calls.

describe('request correlation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stamps X-Request-Id on the response and exposes it to browsers', async () => {
    const response = await SELF.fetch('http://localhost/api/unknown-route');

    const requestId = response.headers.get('X-Request-Id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-Id');
  });

  it('gives each request its own id', async () => {
    const [first, second] = await Promise.all([
      SELF.fetch('http://localhost/api/unknown-route'),
      SELF.fetch('http://localhost/api/unknown-route'),
    ]);

    expect(first.headers.get('X-Request-Id')).not.toBe(second.headers.get('X-Request-Id'));
  });

  it('ignores a client-supplied request id', async () => {
    // Accepting one would let a client merge unrelated requests into a single id
    // and make the logs lie. There is no trusted upstream in front of this Worker.
    const response = await SELF.fetch('http://localhost/api/unknown-route', {
      headers: { 'X-Request-Id': 'client-chosen-id' },
    });

    expect(response.headers.get('X-Request-Id')).not.toBe('client-chosen-id');
  });

  it('logs one summary object per request, with the route class and status', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await SELF.fetch('http://localhost/api/linkblog/resolve/alice.bsky.social');

    const summary = logged.mock.calls
      .map(([entry]) => entry)
      .find(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { event?: string }).event === 'request'
      );

    // An object, not a JSON string: Workers Logs indexes object fields and treats
    // a string as opaque text (see src/utils/logger.ts).
    expect(summary).toBeDefined();
    expect(summary!.route).toBe('/api/linkblog/resolve/:id');
    expect(summary!.method).toBe('GET');
    expect(typeof summary!.status).toBe('number');
    expect(typeof summary!.durationMs).toBe('number');
    expect(summary!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not log a summary line for the shallow health check', async () => {
    // An uptime poller hits it every 30s forever; the line would be pure volume.
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await SELF.fetch('http://localhost/api/health');

    const summaries = logged.mock.calls.filter(
      ([entry]) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { event?: string }).event === 'request'
    );
    expect(summaries).toHaveLength(0);
  });
});

describe('logger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('carries the ambient request context onto every line', () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    runWithRequestContext(
      { requestId: 'req-1', route: '/api/saved/:id', did: 'did:plc:abc' },
      () => {
        log.info('feed_fetched', { feedCount: 3 });
      }
    );

    expect(logged).toHaveBeenCalledWith({
      level: 'info',
      event: 'feed_fetched',
      requestId: 'req-1',
      route: '/api/saved/:id',
      did: 'did:plc:abc',
      feedCount: 3,
    });
  });

  it('works outside a request context', () => {
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});

    log.warn('module_init');

    expect(logged).toHaveBeenCalledWith({ level: 'warn', event: 'module_init' });
    expect(getRequestId()).toBeUndefined();
  });
});

describe('classifyRoute', () => {
  it('collapses identifiers so logs aggregate by endpoint', () => {
    expect(classifyRoute('/api/linkblog/share/3lkabcdef1234')).toBe('/api/linkblog/share/:id');
    expect(classifyRoute('/api/saved/by-guid/https%3A%2F%2Fexample.com')).toBe(
      '/api/saved/by-guid/:id'
    );
    expect(classifyRoute('/api/subscriptions/3lkabcdef1234/activate')).toBe(
      '/api/subscriptions/:id/activate'
    );
  });

  it('leaves static routes alone', () => {
    expect(classifyRoute('/api/auth/me')).toBe('/api/auth/me');
    expect(classifyRoute('/api/health')).toBe('/api/health');
  });

  it('caps the cardinality of junk paths', () => {
    // A scanner hitting random deep paths must not mint a new route value per hit.
    expect(classifyRoute('/api/a/b/c/d/e/f/g')).toBe('/api/a/b/c/…');
  });

  it('collapses everything outside the prefixes this Worker serves', () => {
    // Root-level probes are most of the 404 traffic on a public origin, and each
    // one used to become its own value of the field the runbook aggregates on.
    expect(classifyRoute('/wp-login.php')).toBe('/other');
    expect(classifyRoute('/.env')).toBe('/other');
    expect(classifyRoute('/xyz123')).toBe('/other');
    // The real prefixes still classify normally.
    expect(classifyRoute('/api/auth/me')).toBe('/api/auth/me');
    expect(classifyRoute('/xrpc/app.skyreader.feed.save')).toBe('/xrpc/app.skyreader.feed.save');
  });
});
