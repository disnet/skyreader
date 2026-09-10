import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  linkblogScopes,
  loadLinkblogDocuments,
  rankForLinkblog,
} from '../src/services/linkblog-documents';
import type { LinkblogTarget } from '../src/services/linkblog-sync';
import type { ProxyDocument } from '../src/services/feed-proxy-client';

const AUTHOR = 'did:plc:linkblogauthor00000000';
const OWN = `at://${AUTHOR}/site.standard.publication/3mv4own000000`;
const CONNECTED = `at://${AUTHOR}/site.standard.publication/3mv4connected0`;
const LEGACY = `at://${AUTHOR}/site.standard.publication/skyreader-links`;
const OTHER = `at://${AUTHOR}/site.standard.publication/3mv4unrelated0`;

const target: LinkblogTarget = {
  siteUri: CONNECTED,
  format: 'leaflet',
  external: true,
  defaultSiteUri: OWN,
  legacySiteUri: LEGACY,
};

/**
 * The union shape `site.standard.document.links` takes today. A reader that only
 * understood the legacy array read this as "no links" — which, for a post on a
 * connected publication, meant the linkblog dropped it silently.
 */
function unionLinks(url: string) {
  return { $type: 'app.skyreader.linkblog.links', refs: [{ rel: 'related', uri: url }] };
}

async function seedPublications(): Promise<void> {
  await env.DB.batch(
    [OWN, CONNECTED, LEGACY, OTHER].map((uri) =>
      env.DB.prepare(
        `INSERT INTO publications_cache_v2 (publication_uri, base_url, icon, name, theme, fonts, cached_at)
         VALUES (?, 'https://ex.com', NULL, 'Ex', NULL, NULL, ?)
         ON CONFLICT(publication_uri) DO UPDATE SET cached_at = excluded.cached_at`
      ).bind(uri, Date.now())
    )
  );
}

async function seedDocument(
  rkey: string,
  siteUri: string,
  record: Record<string, unknown>,
  publishedAtMs = Date.now()
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO documents_v2 (record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(
      `at://${AUTHOR}/site.standard.document/${rkey}`,
      AUTHOR,
      rkey,
      `cid-${rkey}`,
      siteUri,
      publishedAtMs,
      JSON.stringify({ site: siteUri, ...record }),
      Date.now()
    )
    .run();
}

/** A Skyreader account for AUTHOR — the precondition on the live PDS fallback. */
async function seedUser(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (did, handle, pds_url) VALUES (?, 'author.test', 'https://pds.test')`
  )
    .bind(AUTHOR)
    .run();
}

function rkeysOf(docs: ProxyDocument[]): string[] {
  return docs.map((d) => d.recordUri.split('/').pop() as string);
}

describe('linkblogScopes', () => {
  it('unions the connected, own and legacy publications, deduped', () => {
    expect(linkblogScopes(target)).toEqual([CONNECTED, OWN, LEGACY]);
  });

  it('collapses to one scope when nothing is connected and there is no legacy', () => {
    expect(
      linkblogScopes({ siteUri: OWN, format: 'leaflet', external: false, defaultSiteUri: OWN })
    ).toEqual([OWN]);
  });
});

describe('rankForLinkblog', () => {
  const doc = (over: Partial<ProxyDocument>): ProxyDocument =>
    ({
      authorDid: AUTHOR,
      recordUri: `at://${AUTHOR}/site.standard.document/${over.recordCid ?? 'x'}`,
      recordCid: 'cid',
      siteUri: OWN,
      title: 't',
      publishedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }) as ProxyDocument;

  it('keeps a link-less post in a publication Skyreader owns', () => {
    expect(rankForLinkblog([doc({ siteUri: OWN })], target)).toHaveLength(1);
    expect(rankForLinkblog([doc({ siteUri: LEGACY })], target)).toHaveLength(1);
  });

  it('drops a link-less post on a connected publication — that is an essay, not a link', () => {
    expect(rankForLinkblog([doc({ siteUri: CONNECTED })], target)).toHaveLength(0);
  });

  it('keeps a post on a connected publication that links out', () => {
    const linked = doc({
      siteUri: CONNECTED,
      links: [{ uri: 'https://ex.com/a', rel: 'related' }],
    });
    expect(rankForLinkblog([linked], target)).toHaveLength(1);
  });

  it('ignores a non-http ref when deciding whether a post links out', () => {
    const atOnly = doc({ siteUri: CONNECTED, links: [{ uri: `at://${AUTHOR}/x/y` }] });
    expect(rankForLinkblog([atOnly], target)).toHaveLength(0);
  });

  it('orders newest-SHARED-first, not by the article publish date', () => {
    // An old article shared today belongs at the top; ranking by publishedAt buries it.
    const oldArticleSharedToday = doc({
      recordCid: 'new-share',
      recordUri: `at://${AUTHOR}/site.standard.document/new-share`,
      publishedAt: '2020-01-01T00:00:00.000Z',
      createdAt: '2026-09-10T00:00:00.000Z',
    });
    const newArticleSharedLastWeek = doc({
      recordCid: 'old-share',
      recordUri: `at://${AUTHOR}/site.standard.document/old-share`,
      publishedAt: '2026-09-09T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(rankForLinkblog([newArticleSharedLastWeek, oldArticleSharedToday], target)).toEqual([
      oldArticleSharedToday,
      newArticleSharedLastWeek,
    ]);
  });
});

describe('loadLinkblogDocuments', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM documents_v2'),
      env.DB.prepare('DELETE FROM document_authors'),
      env.DB.prepare('DELETE FROM publications_cache_v2'),
      env.DB.prepare('DELETE FROM collections_v2'),
      env.DB.prepare('DELETE FROM users WHERE did = ?').bind(AUTHOR),
    ]);
    await seedPublications();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves the union of the linkblog scopes from D1, filtered and newest-shared-first', async () => {
    await seedDocument('own1', OWN, {
      title: 'Own, no link',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await seedDocument('conn1', CONNECTED, {
      title: 'Shared link',
      links: unionLinks('https://ex.com/article'),
      createdAt: '2026-09-05T00:00:00.000Z',
    });
    await seedDocument('conn2', CONNECTED, {
      title: 'An essay with no link',
      createdAt: '2026-09-06T00:00:00.000Z',
    });
    await seedDocument('other1', OTHER, {
      title: 'A different publication entirely',
      links: unionLinks('https://ex.com/nope'),
      createdAt: '2026-09-07T00:00:00.000Z',
    });

    const docs = await loadLinkblogDocuments(env, AUTHOR, target);

    // conn1 (shared 09-05) then own1 (09-01); the connected essay and the
    // out-of-scope publication are both absent.
    expect(rkeysOf(docs)).toEqual(['conn1', 'own1']);
  });

  it('reads the current links union, so a shared post is not silently dropped', async () => {
    await seedDocument('union', CONNECTED, {
      title: 'Union-shaped links',
      links: unionLinks('https://augmentingcognition.com/ltm.html'),
    });

    const [doc] = await loadLinkblogDocuments(env, AUTHOR, target);
    expect(doc.links).toEqual([
      { uri: 'https://augmentingcognition.com/ltm.html', rel: 'related' },
    ]);
  });

  it('still reads the legacy array shape', async () => {
    await seedDocument('legacyshape', CONNECTED, {
      title: 'Array links',
      links: [{ rel: 'related', uri: 'https://ex.com/old' }],
    });

    const [doc] = await loadLinkblogDocuments(env, AUTHOR, target);
    expect(doc.links).toEqual([{ uri: 'https://ex.com/old', rel: 'related' }]);
  });

  it('carries skyreaderAttribution through, so the note stripper can trust it', async () => {
    await seedDocument('attributed', OWN, {
      title: 'Attributed',
      skyreaderAttribution: true,
    });

    const [doc] = await loadLinkblogDocuments(env, AUTHOR, target);
    expect(doc.skyreaderAttribution).toBe(true);
  });

  it('returns nothing for a malformed DID rather than listing anyone', async () => {
    expect(await loadLinkblogDocuments(env, 'not-a-did', target)).toEqual([]);
  });

  // The route in front of this is unauthenticated, and the rate limiter keys on a
  // session it will never have. So an unknown DID must not turn into an outbound
  // walk: `did:web:<host-I-control>` would otherwise make the Worker fetch my
  // server as fast as I can loop, and pay for it.
  it('does not reach the PDS for a DID that is not a Skyreader account', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(await loadLinkblogDocuments(env, AUTHOR, target)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The other half of the gate: a registered author nobody subscribes to has
  // nothing stored, and their public linkblog still has to render.
  it('lists from the PDS for a registered account with nothing stored', async () => {
    await seedUser();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('not found', { status: 404 }));

    expect(await loadLinkblogDocuments(env, AUTHOR, target)).toEqual([]);
    expect(fetchSpy).toHaveBeenCalled();
  });

  // A curated edition resolves its items across foreign PDSes and writes the
  // preview back. This page renders none of that — its `ProxyDocument` doesn't
  // declare `readerCollection` — so an anonymous view of an author who publishes
  // editions must not pay for it, once per scope, on every cold preview.
  it('does not resolve curated editions, which the public page never renders', async () => {
    await seedDocument('edition', OWN, {
      title: 'A curated edition',
      links: unionLinks('https://ex.com/edition'),
    });
    await env.DB.prepare(
      `INSERT INTO collections_v2 (author_did, rkey, record_json, preview_json, preview_at, indexed_at)
       VALUES (?, 'edition', ?, NULL, NULL, ?)`
    )
      .bind(
        AUTHOR,
        JSON.stringify({
          items: [{ document: 'at://did:plc:someoneelse000000000/site.standard.document/abc' }],
        }),
        Date.now()
      )
      .run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const [doc] = await loadLinkblogDocuments(env, AUTHOR, target);

    expect(rkeysOf([doc])).toEqual(['edition']);
    expect(doc.readerCollection).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
