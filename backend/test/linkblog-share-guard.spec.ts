import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ATTRIBUTION_TEXT,
  deleteLinkblog,
  deleteLinkblogShare,
  updateLinkblogShareNote,
  LINKBLOG_MARKER_URL,
  publicationUri,
} from '../src/services/linkblog-sync';
import { OFFPRINT_SCOPES } from '../src/config/scopes';
import type { Env, Session } from '../src/types';

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

// One of OUR link posts: carries the provenance marker, so the delete walk picks
// it up out of a connected publication that also holds the home app's own posts.
function ourShare(overrides: Record<string, unknown> = {}) {
  return documentRecord({ skyreaderLinkblog: LINKBLOG_MARKER_URL, ...overrides });
}

function record(rkey: string, value: Record<string, unknown>) {
  return { uri: `at://${DID}/site.standard.document/${rkey}`, cid: 'bafy', value };
}

interface ListPage {
  records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>;
  cursor?: string;
}

// Stub the PDS for a full-linkblog delete: `page` answers each listRecords call
// by cursor, and every applyWrites body is handed to `onApplyWrites` so a test
// can assert which collections were addressed.
function stubDeleteWalk(
  page: (cursor: string | null) => ListPage,
  options: { onApplyWrites?: (body: { writes: Array<{ collection: string }> }) => void } = {}
) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const endpoint = url.pathname.split('/xrpc/')[1];
    if (endpoint === 'com.atproto.repo.listRecords') {
      return Response.json(page(url.searchParams.get('cursor')));
    }
    if (endpoint === 'com.atproto.repo.applyWrites') {
      options.onApplyWrites?.(JSON.parse((init?.body as string) ?? '{"writes":[]}'));
    }
    return Response.json({});
  }) as unknown as typeof fetch;
}

// A D1 stub that records the SQL it was handed, so a test can assert which
// settings a failed delete did and didn't touch. `row` is what every `.first()`
// returns — enough to stand in for the user_settings lookups the delete makes
// (its own disabled flag, and the linkblog target).
function dbStub(row: Record<string, unknown> | null = null) {
  const sql: string[] = [];
  const statement = {
    bind: vi.fn(() => statement),
    run: vi.fn(async () => ({})),
    first: vi.fn(async () => row),
  };
  const env = {
    DB: {
      prepare: vi.fn((query: string) => {
        sql.push(query);
        return statement;
      }),
    },
  } as unknown as Env;
  return { env, sql };
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

  // Whether that trailing sentence is ours or the author's is a property of the
  // RECORD (`skyreaderAttribution`), not of the string. Read it off the record, or
  // an author who wrote it themselves gets it duplicated on every edit and can
  // never delete it.
  it('does not duplicate an author’s own attribution-shaped line on edit', async () => {
    const calls = stubPds(
      documentRecord({
        site: publicationUri(DID),
        content: {
          $type: 'pub.leaflet.content',
          pages: [
            {
              $type: 'pub.leaflet.pages.linearDocument',
              blocks: [
                { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'Worth reading.' } },
                { block: { $type: 'pub.leaflet.blocks.text', plaintext: ATTRIBUTION_TEXT } },
                {
                  block: {
                    $type: 'pub.leaflet.blocks.website',
                    src: 'https://example.com/an-article',
                  },
                },
              ],
            },
          ],
        },
      })
    );

    const result = await updateLinkblogShareNote(
      SESSION,
      '3kabc',
      `Worth reading, still.\n\n${ATTRIBUTION_TEXT}`
    );

    expect(result.success).toBe(true);
    const put = calls.find((c) => c.endpoint === 'com.atproto.repo.putRecord');
    const blocks = (
      put?.body as {
        record: {
          content: { pages: Array<{ blocks: Array<{ block: { plaintext?: string } }> }> };
        };
      }
    ).record.content.pages[0].blocks;
    expect(blocks.filter((b) => b.block.plaintext === ATTRIBUTION_TEXT)).toHaveLength(1);
  });

  it('carries the attribution line it added, once, when the record flag says so', async () => {
    const calls = stubPds(
      documentRecord({
        site: publicationUri(DID),
        skyreaderAttribution: true,
        content: {
          $type: 'pub.leaflet.content',
          pages: [
            {
              $type: 'pub.leaflet.pages.linearDocument',
              blocks: [
                { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'Worth reading.' } },
                {
                  block: {
                    $type: 'pub.leaflet.blocks.website',
                    src: 'https://example.com/an-article',
                  },
                },
                { block: { $type: 'pub.leaflet.blocks.text', plaintext: ATTRIBUTION_TEXT } },
              ],
            },
          ],
        },
      })
    );

    const result = await updateLinkblogShareNote(SESSION, '3kabc', 'Revised.');

    expect(result.success).toBe(true);
    const put = calls.find((c) => c.endpoint === 'com.atproto.repo.putRecord');
    const blocks = (
      put?.body as {
        record: {
          content: { pages: Array<{ blocks: Array<{ block: { plaintext?: string } }> }> };
        };
      }
    ).record.content.pages[0].blocks;
    expect(blocks.map((b) => b.block.plaintext)).toEqual(['Revised.', undefined, ATTRIBUTION_TEXT]);
  });

  it('walks the collection once, deleting as it pages', async () => {
    // listRecords' cursor is an exclusive rkey bound, not an offset, so deleting
    // a page can't shift a later record past the cursor. The walk stays linear:
    // no page is ever fetched twice.
    const cursors: Array<string | null> = [];
    let deleted = false;
    stubDeleteWalk(
      (cursor) => {
        cursors.push(cursor);
        if (!cursor) return { records: [record('foreign', documentRecord())], cursor: 'next' };
        if (!deleted) return { records: [record('ours', ourShare())], cursor: 'more' };
        return { records: [] };
      },
      {
        onApplyWrites: () => {
          deleted = true;
        },
      }
    );
    const { env } = dbStub();

    const result = await deleteLinkblog(SESSION, env);

    expect(result.success).toBe(true);
    expect(result.success && result.data.deletedPosts).toBe(1);
    expect(cursors).toEqual([null, 'next', 'more']);
  });

  it('deletes only the companion the record was actually written in', async () => {
    // Both companion collections used to be addressed for every rkey. Neither is
    // in LINKBLOG_SCOPES, so on a large linkblog that was two guaranteed-failing
    // applyWrites plus a per-record fallback behind each — enough to burn the
    // Worker's subrequest budget before the delete finished.
    const collections: string[] = [];
    stubDeleteWalk(
      (cursor) =>
        cursor
          ? { records: [] }
          : {
              records: [
                record('offprint-share', ourShare({ content: { $type: 'app.offprint.content' } })),
                record('leaflet-share', ourShare()),
              ],
            },
      { onApplyWrites: (body) => collections.push(body.writes[0].collection) }
    );
    const { env } = dbStub();

    const session = { ...SESSION, grantedScopes: OFFPRINT_SCOPES.join(' ') } as Session;
    const result = await deleteLinkblog(session, env);

    expect(result.success).toBe(true);
    expect(collections).toEqual(['site.standard.document', 'app.offprint.document.article']);
    expect(collections).not.toContain('blog.pckt.document');
  });

  it('skips the companion entirely when the session never held that app’s scope', async () => {
    const collections: string[] = [];
    stubDeleteWalk(
      (cursor) =>
        cursor
          ? { records: [] }
          : {
              records: [
                record('offprint-share', ourShare({ content: { $type: 'app.offprint.content' } })),
              ],
            },
      { onApplyWrites: (body) => collections.push(body.writes[0].collection) }
    );
    const { env } = dbStub();

    const result = await deleteLinkblog(SESSION, env);

    expect(result.success).toBe(true);
    expect(collections).toEqual(['site.standard.document']);
  });

  it('caps the per-record companion fallback across the whole walk', async () => {
    // A companion batch that keeps failing degrades to one deleteRecord per
    // record. Unbounded that's a subrequest per companion for every page, which
    // exhausts the Worker's budget and strands the delete half-done. Documents
    // still go; the leftover companions are orphaned on purpose.
    const PAGES = 6;
    const PER_PAGE = 100;
    let deleteRecordCalls = 0;
    let page = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const endpoint = url.pathname.split('/xrpc/')[1];
      if (endpoint === 'com.atproto.repo.listRecords') {
        if (page >= PAGES) return Response.json({ records: [] });
        const records = Array.from({ length: PER_PAGE }, (_, i) =>
          record(`r${page}-${i}`, ourShare({ content: { $type: 'app.offprint.content' } }))
        );
        page++;
        return Response.json({ records, cursor: `page-${page}` });
      }
      if (endpoint === 'com.atproto.repo.applyWrites') {
        const body = JSON.parse((init?.body as string) ?? '{"writes":[]}');
        // Documents succeed; the companion collection fails every time.
        if (body.writes[0]?.collection !== 'site.standard.document') {
          return Response.json({ error: 'InvalidRequest' }, { status: 400 });
        }
      }
      if (endpoint === 'com.atproto.repo.deleteRecord') {
        // Count only the companion fallback, not the single publication-record
        // delete that closes out a successful walk.
        const body = JSON.parse((init?.body as string) ?? '{}');
        if (body.collection !== 'site.standard.publication') deleteRecordCalls++;
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    const { env } = dbStub();

    const session = { ...SESSION, grantedScopes: OFFPRINT_SCOPES.join(' ') } as Session;
    const result = await deleteLinkblog(session, env);

    expect(result.success).toBe(true);
    expect(result.success && result.data.deletedPosts).toBe(PAGES * PER_PAGE);
    // Bounded by the budget, not by the repo: without the cap this would be one
    // call per companion record (600), and it grows with the linkblog.
    expect(deleteRecordCalls).toBeLessThanOrEqual(200);
    expect(deleteRecordCalls).toBeGreaterThan(0);
  });

  it('puts the disabled flag back when the walk fails before deleting anything', async () => {
    // The flag goes on first so a share can't race the walk. If the PDS side
    // never happened, leaving it on would strand the user with a live linkblog
    // that every write path rejects.
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'InternalServerError' }, { status: 500 })
    ) as unknown as typeof fetch;
    const { env, sql } = dbStub();

    const result = await deleteLinkblog(SESSION, env);

    expect(result.success).toBe(false);
    expect(sql.filter((s) => /linkblog_disabled = 1/.test(s))).toHaveLength(1);
    expect(sql.filter((s) => /linkblog_disabled = 0/.test(s))).toHaveLength(1);
    // The connected publication is the one thing a restore can't give back, so a
    // failed delete must not clear it.
    expect(sql.some((s) => /linkblog_publication = NULL/.test(s))).toBe(false);
  });

  it('keeps the flag when a retry of a partial delete fails having deleted nothing', async () => {
    // A delete that got partway leaves the flag on. Retrying it can fail before
    // deleting anything of its OWN — but the posts the first attempt took are
    // still gone. Rolling back on this call's zero count would hand back a
    // linkblog silently missing them, which is the one state the flag exists to
    // prevent. Already-disabled on entry is what tells the two apart.
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'InternalServerError' }, { status: 500 })
    ) as unknown as typeof fetch;
    const { env, sql } = dbStub({ linkblog_disabled: 1 });

    const result = await deleteLinkblog(SESSION, env);

    expect(result.success).toBe(false);
    expect(sql.some((s) => /linkblog_disabled = 0/.test(s))).toBe(false);
  });
});
