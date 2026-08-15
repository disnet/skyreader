import { SELF } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Phase 3: the client can finally say "I broke". Everything it says is untrusted,
// so these pin the boundary — what is accepted, what is capped, and what never
// leaves the request (query strings, unknown kinds, oversized payloads).

const post = (body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch('http://localhost/api/telemetry/error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const report = (overrides: Record<string, unknown> = {}) => ({
  kind: 'uncaught',
  name: 'TypeError',
  message: 'x is not a function',
  stack: 'TypeError: x is not a function\n  at foo (/_app/immutable/chunks/abc.js:1:1)',
  appVersion: 'deadbeef',
  path: '/reader/article',
  sampleRate: 0.1,
  ...overrides,
});

/** The one structured line this endpoint emits, if it emitted one. */
function clientErrorLine(warn: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
  return warn.mock.calls
    .map(([entry]) => entry)
    .find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { event?: string }).event === 'client_error'
    );
}

describe('POST /api/telemetry/error', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts a well-formed report without a session', async () => {
    // An error on the login screen has no DID and is exactly the kind we want.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await post(report());

    expect(response.status).toBe(204);
    const line = clientErrorLine(warn);
    expect(line).toMatchObject({
      level: 'warn',
      kind: 'uncaught',
      errorName: 'TypeError',
      appVersion: 'deadbeef',
      path: '/reader/article',
    });
    // Correlatable with the rest of the request, like every other line.
    expect(line!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a kind it does not recognise', async () => {
    // `kind` is a Sentry tag and a log facet; an open set would let a client mint
    // unbounded values in both.
    const response = await post(report({ kind: 'marketing_funnel' }));
    expect(response.status).toBe(400);
  });

  it('rejects a report with nothing to say', async () => {
    expect((await post(report({ message: '   ' }))).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect((await post([1, 2, 3])).status).toBe(400);
  });

  it('refuses anything but POST', async () => {
    const response = await SELF.fetch('http://localhost/api/telemetry/error');
    expect(response.status).toBe(405);
  });

  it('rejects an oversized payload before reading it', async () => {
    const response = await post(report(), { 'Content-Length': String(64 * 1024) });
    expect(response.status).toBe(413);
  });

  it('keeps the path but drops the query string and the origin', async () => {
    // A URL is where credentials leak in: share tokens, OAuth params, handles.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await post(report({ path: 'https://skyreader.app/saved?token=secret#frag' }));

    expect(clientErrorLine(warn)!.path).toBe('/saved');
  });

  it('caps a runaway message and stack instead of forwarding them whole', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await post(report({ message: 'a'.repeat(5000), stack: 'b'.repeat(8000) }));

    expect(response.status).toBe(204);
    const line = clientErrorLine(warn)!;
    expect((line.errorMessage as string).length).toBeLessThanOrEqual(301);
  });

  it('defaults a nameless error rather than dropping the report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await post({ kind: 'rejection', message: 'undefined' });

    expect(response.status).toBe(204);
    expect(clientErrorLine(warn)!.errorName).toBe('Error');
  });

  it('stops a client stuck in an error loop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const headers = { 'CF-Connecting-IP': '203.0.113.7' };

    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await post(report(), headers)).status);
    }

    expect(statuses.filter((s) => s === 204).length).toBe(20);
    expect(statuses.filter((s) => s === 429).length).toBe(5);
    // No Retry-After: a broken page should drop the report, not schedule it.
    const limited = await post(report(), headers);
    expect(limited.headers.get('Retry-After')).toBeNull();
  });
});
