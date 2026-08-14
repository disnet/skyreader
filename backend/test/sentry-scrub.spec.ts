import { describe, it, expect } from 'vitest';
import type { Event } from '@sentry/cloudflare';
import { scrubEvent } from '../src/observability/scrub';

describe('Sentry event scrubbing', () => {
  it('redacts credential headers and drops cookies', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api.skyreader.app/api/saved',
        headers: {
          Authorization: 'DPoP eyJhbGciOi.secret.token',
          'X-Health-Secret': 'super-secret',
          Cookie: 'session_id=abc123',
          DPoP: 'eyJ0eXAiOiJkcG9wK2p3dCJ9.proof',
          'User-Agent': 'Skyreader/1.0',
        },
        cookies: { session_id: 'abc123' },
      },
    } as Event);

    const headers = event.request!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('[redacted]');
    expect(headers['X-Health-Secret']).toBe('[redacted]');
    expect(headers.Cookie).toBe('[redacted]');
    expect(headers.DPoP).toBe('[redacted]');
    // Non-sensitive headers survive — the point is triage, not a blank event.
    expect(headers['User-Agent']).toBe('Skyreader/1.0');
    expect(event.request!.cookies).toBeUndefined();
  });

  it('redacts OAuth params in the query string but keeps the rest', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api.skyreader.app/api/auth/callback',
        query_string: 'code=abc123&state=xyz&iss=https%3A%2F%2Fbsky.social',
      },
    } as Event);

    const query = event.request!.query_string as string;
    expect(query).toContain('code=%5Bredacted%5D');
    expect(query).toContain('state=%5Bredacted%5D');
    expect(query).toContain('iss=https');
    expect(query).not.toContain('abc123');
  });

  it('redacts OAuth params carried inline in the url', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api.skyreader.app/api/auth/callback?code=abc123&iss=https%3A%2F%2Fbsky.social',
      },
    } as Event);

    expect(event.request!.url).not.toContain('abc123');
    expect(event.request!.url).toContain('/api/auth/callback?');
    expect(event.request!.url).toContain('iss=https');
  });

  it('redacts tokens nested in a JSON body but keeps the DID', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api.skyreader.app/api/sync/full',
        data: {
          did: 'did:plc:abc123',
          tokens: { access_token: 'at-secret', refresh_token: 'rt-secret' },
          dpopPrivateKey: '{"d":"..."}',
        },
      },
    } as Event);

    const data = event.request!.data as Record<string, unknown>;
    // DIDs are public identifiers and the correlation key we actually want.
    expect(data.did).toBe('did:plc:abc123');
    expect(data.tokens).toBe('[redacted]');
    expect(data.dpopPrivateKey).toBe('[redacted]');
  });

  it('redacts a raw string body too', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api.skyreader.app/oauth/token',
        data: JSON.stringify({ refresh_token: 'rt-secret', did: 'did:plc:abc123' }),
      },
    } as Event);

    expect(event.request!.data as string).not.toContain('rt-secret');
    expect(event.request!.data as string).toContain('did:plc:abc123');
  });

  it('redacts secrets in extra context', () => {
    const event = scrubEvent({
      extra: { feedUrl: 'https://example.com/rss', proxySecret: 'shh' },
    } as Event);

    expect(event.extra!.feedUrl).toBe('https://example.com/rss');
    expect(event.extra!.proxySecret).toBe('[redacted]');
  });

  // Breadcrumbs are the channel that bypasses every request-level rule above:
  // whatever a call site logged before the throw ships verbatim. The Console
  // integration is off (see observability/sentry.ts), but anything added another
  // way still has to come out clean.
  it('redacts credentials carried in breadcrumbs', () => {
    const event = scrubEvent({
      breadcrumbs: [
        {
          message:
            'GET https://bsky.social/xrpc/com.atproto.server.refreshSession?refresh_token=rt-secret failed',
        },
        { message: 'sending header Authorization: Bearer eyJhbGciOiJFUzI1NiJ9.payload.sig' },
        { message: 'resolving handle for did:plc:abc123' },
        { data: { session_id: 'sid-secret', url: 'https://example.com/rss' } },
      ],
    } as Event);

    const [tokenizedUrl, authHeader, harmless, withData] = event.breadcrumbs!;
    expect(tokenizedUrl.message).not.toContain('rt-secret');
    expect(tokenizedUrl.message).toContain('com.atproto.server.refreshSession');
    expect(authHeader.message).not.toContain('eyJhbGciOiJFUzI1NiJ9');
    expect(authHeader.message).toBe('sending header Authorization: [redacted]');
    // DIDs survive — they're the correlation key, not a credential.
    expect(harmless.message).toBe('resolving handle for did:plc:abc123');
    expect((withData.data as Record<string, unknown>).session_id).toBe('[redacted]');
    expect((withData.data as Record<string, unknown>).url).toBe('https://example.com/rss');
  });

  // The shapes that can't be redacted in place: a scrub that only mutates would
  // pass these through untouched while reading as if it had worked.
  it('redacts a breadcrumb or extra that is a bare string or array', () => {
    const tokenized = 'fetching https://example.com/rss?token=feed-secret';
    const event = scrubEvent({
      breadcrumbs: [{ data: tokenized as unknown as Record<string, unknown> }],
      extra: [tokenized] as unknown as Event['extra'],
    } as Event);

    expect(event.breadcrumbs![0].data as unknown as string).not.toContain('feed-secret');
    expect((event.extra as unknown as string[])[0]).not.toContain('feed-secret');
  });

  it('redacts a tokenized URL quoted in the exception message', () => {
    const event = scrubEvent({
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'fetch failed: https://pds.example/xrpc/foo?access_token=at-secret&limit=50',
          },
        ],
      },
      message: 'code_verifier=cv-secret was rejected',
    } as Event);

    const value = event.exception!.values![0].value!;
    expect(value).not.toContain('at-secret');
    expect(value).toContain('limit=50');
    expect(event.message).not.toContain('cv-secret');
  });

  it('leaves an event with nothing sensitive untouched', () => {
    const event = scrubEvent({
      request: { url: 'https://api.skyreader.app/api/feeds', query_string: 'limit=50' },
    } as Event);

    expect(event.request!.query_string).toBe('limit=50');
  });
});
