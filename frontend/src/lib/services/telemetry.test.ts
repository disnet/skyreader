import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportClientError, resetTelemetryForTests } from './telemetry';

// The reporter runs on a page that is already broken, so the properties worth
// pinning are the restraints: it samples, it repeats itself at most once, it
// gives up rather than retrying, and it never lets its own failure surface.

const posts = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTelemetryForTests();
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { location: { pathname: '/reader' } });
  // Sampling is a coin flip; these tests are about everything else.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reportClientError', () => {
  it('sends a name, message, stack, build and path — and nothing else', () => {
    const error = new TypeError('x is not a function');
    error.stack = 'TypeError: x is not a function\n  at foo';

    reportClientError('uncaught', error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/telemetry/error');
    expect((init as RequestInit).keepalive).toBe(true);
    expect(posts()[0]).toEqual({
      kind: 'uncaught',
      name: 'TypeError',
      message: 'x is not a function',
      stack: 'TypeError: x is not a function\n  at foo',
      appVersion: 'test-build-sha',
      path: '/reader',
      sampleRate: 0.1,
    });
  });

  it('drops nine in ten reports', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    reportClientError('rejection', new Error('nope'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('always sends the failure that means the app cannot recover', () => {
    // A 90% chance of never hearing that a deploy bricked the PWA is not a
    // tradeoff worth making — this is the one kind sampling doesn't apply to.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    reportClientError('preload_recovery_failed', new Error('preload failed again'));
    expect(posts()[0]).toMatchObject({ kind: 'preload_recovery_failed', sampleRate: 1 });
  });

  it('says the same thing at most once per page load', () => {
    for (let i = 0; i < 10; i++) reportClientError('rejection', new Error('same'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops entirely once a page is throwing in many ways', () => {
    for (let i = 0; i < 20; i++) reportClientError('rejection', new Error(`error ${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('stays quiet while offline', () => {
    vi.stubGlobal('navigator', { onLine: false });
    reportClientError('uncaught', new Error('boom'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles a thrown non-Error without throwing itself', () => {
    reportClientError('rejection', 'just a string');
    reportClientError('rejection', { message: 'object with a message' });
    reportClientError('rejection', undefined);
    expect(posts().map((p) => p.message)).toEqual([
      'just a string',
      'object with a message',
      'undefined',
    ]);
  });

  it('truncates rather than shipping an unbounded message', () => {
    reportClientError('uncaught', new Error('a'.repeat(5000)));
    expect(posts()[0].message.length).toBe(301);
  });

  it('swallows a failed report instead of raising a second error', () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('network down')));
    expect(() => reportClientError('uncaught', new Error('boom'))).not.toThrow();
  });
});
