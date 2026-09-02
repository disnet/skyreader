import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleV2FeedDiscover } from '../src/routes/feeds-v2';
import type { Env } from '../src/types';

const ENV = {
  FEED_PROXY_URL: 'https://proxy.example',
  FEED_PROXY_SECRET: 'test-secret',
} as Env;

function request(siteUrl: string): Request {
  return new Request(
    `https://api.example/api/v2/feeds/discover?url=${encodeURIComponent(siteUrl)}`
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The brennan.day shape from #435: an article page advertising its document
 * first and its publication second, where the site writes at:// URIs with a
 * *handle* authority while the document record points at the did:plc spelling of
 * the same publication.
 */
const DOC_DID = 'did:plc:h4fm3emeptzegfs452eoiaz7';
const PDS = 'https://scalycap.us-west.host.bsky.network';
const DOC_URI = `at://${DOC_DID}/site.standard.document/3muhkhf6unv2x`;
const PUB_URI_DID = `at://${DOC_DID}/site.standard.publication/self`;
const PUB_URI_HANDLE = 'at://brennan.day/site.standard.publication/self';

interface Routes {
  standardSites?: string[];
  feeds?: string[];
  /** What /.well-known/site.standard.publication advertises back. */
  wellKnown?: string;
  /** Document records that exist, keyed by rkey. */
  documents?: Record<string, unknown>;
}

function mockNetwork(routes: Routes = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    if (url.startsWith('https://proxy.example/discover')) {
      return json({
        feeds: routes.feeds ?? [],
        standardSites: routes.standardSites ?? [],
      });
    }
    if (url === `https://plc.directory/${DOC_DID}`) {
      return json({
        id: DOC_DID,
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
      });
    }
    if (url.includes('com.atproto.identity.resolveHandle')) {
      const handle = new URL(url).searchParams.get('handle');
      return handle === 'brennan.day' ? json({ did: DOC_DID }) : json({}, 400);
    }
    if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.getRecord`)) {
      const params = new URL(url).searchParams;
      const collection = params.get('collection');
      const rkey = params.get('rkey') ?? '';
      if (collection === 'site.standard.document') {
        const value = (routes.documents ?? {})[rkey];
        return value ? json({ value }) : json({ error: 'RecordNotFound' }, 400);
      }
      if (collection === 'site.standard.publication' && rkey === 'self') {
        return json({
          value: {
            $type: 'site.standard.publication',
            url: 'https://brennan.day',
            name: 'brennan.day',
          },
        });
      }
      return json({ error: 'RecordNotFound' }, 400);
    }
    if (url === 'https://brennan.day/.well-known/site.standard.publication') {
      return new Response(routes.wellKnown ?? PUB_URI_HANDLE, {
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

describe('handleV2FeedDiscover — standard.site resolution', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('verifies a publication whose domain advertises it with a handle authority', async () => {
    mockNetwork({
      standardSites: [DOC_URI],
      documents: { '3muhkhf6unv2x': { site: PUB_URI_DID } },
    });

    const res = await handleV2FeedDiscover(request('https://brennan.day/some-post/'), ENV);
    const body = (await res.json()) as { standardSite: { publicationUri: string; did: string } };

    expect(res.status).toBe(200);
    // Before #435 this was null: the well-known's handle spelling was compared
    // as a string against the DID spelling we had resolved.
    expect(body.standardSite).not.toBeNull();
    expect(body.standardSite.publicationUri).toBe(PUB_URI_DID);
    expect(body.standardSite.did).toBe(DOC_DID);
  });

  it('accepts a handle-authority publication hint and reports it in DID form', async () => {
    mockNetwork({ standardSites: [PUB_URI_HANDLE] });

    const res = await handleV2FeedDiscover(request('https://brennan.day/'), ENV);
    const body = (await res.json()) as { standardSite: { publicationUri: string } };

    expect(body.standardSite.publicationUri).toBe(PUB_URI_DID);
  });

  it('falls through to the next hint when the first one does not resolve', async () => {
    // The page advertises a document whose record is missing, then the
    // publication. Trying only the first hint dropped the publication entirely.
    mockNetwork({ standardSites: [DOC_URI, PUB_URI_HANDLE], documents: {} });

    const res = await handleV2FeedDiscover(request('https://brennan.day/some-post/'), ENV);
    const body = (await res.json()) as { standardSite: { publicationUri: string } | null };

    expect(body.standardSite?.publicationUri).toBe(PUB_URI_DID);
  });

  it('still rejects a publication the domain does not claim back', async () => {
    mockNetwork({
      standardSites: [PUB_URI_HANDLE],
      wellKnown: 'at://did:plc:someoneelse/site.standard.publication/self',
    });

    const res = await handleV2FeedDiscover(request('https://brennan.day/'), ENV);
    const body = (await res.json()) as { standardSite: unknown };

    expect(body.standardSite).toBeNull();
  });

  it('does not try to resolve an authority that is not a public domain', async () => {
    const calls = mockNetwork({ standardSites: ['at://localhost/site.standard.publication/self'] });

    const res = await handleV2FeedDiscover(request('https://brennan.day/'), ENV);
    const body = (await res.json()) as { standardSite: unknown };

    expect(body.standardSite).toBeNull();
    expect(calls.some((c) => c.includes('resolveHandle'))).toBe(false);
  });

  it('stops after three hints rather than fanning out over a page full of them', async () => {
    const hints = ['a', 'b', 'c', 'd', 'e'].map(
      (id) => `at://did:plc:${id}/site.standard.publication/self`
    );
    // Every DID here is unknown to plc.directory, so each attempt dies at PDS
    // resolution — what the test reads is how many were attempted at all.
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return url.startsWith('https://proxy.example/discover')
        ? json({ feeds: [], standardSites: hints })
        : json({ error: 'not found' }, 404);
    }) as unknown as typeof fetch;

    const res = await handleV2FeedDiscover(request('https://brennan.day/'), ENV);
    const body = (await res.json()) as { standardSite: unknown };

    expect(body.standardSite).toBeNull();
    expect(calls.filter((c) => c.startsWith('https://plc.directory/'))).toHaveLength(3);
  });
});
