import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deleteLinkblogShare,
  updateLinkblogShareNote,
  LINKBLOG_MARKER_URL,
  publicationUri,
} from '../src/services/linkblog-sync';
import type { Session } from '../src/types';

// A connected linkblog publishes into a publication its HOME app owns, which also
// holds that app's own posts — and an essay that links out is shaped exactly like
// a share. So both mutating paths read the record back first and act only on
// documents Skyreader actually wrote (marker, or our own publication). Getting
// this wrong deletes someone's Leaflet post, with no undo.

const DID = 'did:plc:guardtest';
const CONNECTED = `at://${DID}/site.standard.publication/my-leaflet`;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const SESSION: Session = {
  did: DID,
  handle: 'guard.test',
  pdsUrl: 'https://test.pds.example',
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token',
  dpopPrivateKey: JSON.stringify(TEST_DPOP_KEY),
  expiresAt: Date.now() + 3_600_000,
} as Session;

function leafletBody(text: string) {
  return {
    $type: 'pub.leaflet.content',
    pages: [
      {
        $type: 'pub.leaflet.pages.linearDocument',
        blocks: [{ block: { $type: 'pub.leaflet.blocks.text', plaintext: text } }],
      },
    ],
  };
}

function documentRecord(overrides: Record<string, unknown> = {}) {
  return {
    $type: 'site.standard.document',
    site: CONNECTED,
    title: 'A post',
    path: '/3kabc',
    publishedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    links: [{ uri: 'https://example.com/an-article', rel: 'related' }],
    content: leafletBody('Some words.'),
    ...overrides,
  };
}

// Stub the PDS: getRecord returns `record` (or a not-found error), and every
// write is recorded so a test can assert it never happened.
function stubPds(record: Record<string, unknown> | 'missing') {
  const calls: Array<{ endpoint: string; body?: unknown }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const endpoint = url.split('/xrpc/')[1]?.split('?')[0] ?? url;
    calls.push({ endpoint, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (endpoint === 'com.atproto.repo.getRecord') {
      if (record === 'missing') {
        return new Response(
          JSON.stringify({ error: 'RecordNotFound', message: 'Could not locate record' }),
          { status: 400 }
        );
      }
      return new Response(JSON.stringify({ uri: 'at://x', cid: 'bafy', value: record }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ uri: 'at://x', cid: 'bafy' }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

describe('linkblog share guards', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('refuses to delete a post the connected publication’s own app wrote', async () => {
    const calls = stubPds(documentRecord());
    const result = await deleteLinkblogShare(SESSION, '3kabc');
    expect(result.success).toBe(false);
    expect(calls.some((c) => c.endpoint === 'com.atproto.repo.deleteRecord')).toBe(false);
  });

  it('deletes a Skyreader share in a connected publication (it carries the marker)', async () => {
    const calls = stubPds(documentRecord({ skyreaderLinkblog: LINKBLOG_MARKER_URL }));
    const result = await deleteLinkblogShare(SESSION, '3kabc');
    expect(result.success).toBe(true);
    expect(calls.some((c) => c.endpoint === 'com.atproto.repo.deleteRecord')).toBe(true);
  });

  it('deletes an unmarked share in the user’s own Skyreader publication', async () => {
    // Everything in `skyreader-links` is ours, including pre-marker records.
    const calls = stubPds(documentRecord({ site: publicationUri(DID) }));
    const result = await deleteLinkblogShare(SESSION, '3kabc');
    expect(result.success).toBe(true);
    expect(calls.some((c) => c.endpoint === 'com.atproto.repo.deleteRecord')).toBe(true);
  });

  it('treats an already-deleted record as a successful un-share', async () => {
    const calls = stubPds('missing');
    const result = await deleteLinkblogShare(SESSION, '3kabc');
    expect(result.success).toBe(true);
    expect(calls.some((c) => c.endpoint === 'com.atproto.repo.deleteRecord')).toBe(false);
  });

  it('refuses to rewrite the note region of a home-app post', async () => {
    const calls = stubPds(documentRecord());
    const result = await updateLinkblogShareNote(SESSION, '3kabc', 'my commentary');
    expect(result.success).toBe(false);
    expect(calls.some((c) => c.endpoint === 'com.atproto.repo.putRecord')).toBe(false);
  });

  it('edits a marked share and backfills the marker on an unmarked own-publication one', async () => {
    const calls = stubPds(documentRecord({ site: publicationUri(DID) }));
    const result = await updateLinkblogShareNote(SESSION, '3kabc', 'my commentary');
    expect(result.success).toBe(true);
    const put = calls.find((c) => c.endpoint === 'com.atproto.repo.putRecord');
    expect((put?.body as { record: { skyreaderLinkblog?: string } }).record.skyreaderLinkblog).toBe(
      LINKBLOG_MARKER_URL
    );
  });
});
