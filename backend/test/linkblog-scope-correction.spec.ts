import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleV2BatchDocumentFetch } from '../src/routes/feeds-v2';
import { publicationUri } from '../src/services/linkblog-sync';
import type { Env, Session } from '../src/types';

// A follower's document scope lives on their device (the local subscription's
// feedUrl) and in their PDS record. When an author connects an existing
// publication we rewrite the D1 row, but nothing can reach into every client, so
// the client keeps asking for the abandoned publication — and the proxy, which
// filters by site URI, quietly returns nothing forever. The batch endpoint
// corrects the scope on the way out and echoes the requested one back, so the
// client's digests and per-scope reconciliation keys are untouched.

const READER = 'did:plc:scope-reader';
const AUTHOR = 'did:plc:scope-author';
const CONNECTED = `at://${AUTHOR}/site.standard.publication/my-leaflet`;
const NEXT = `at://${AUTHOR}/site.standard.publication/my-pckt`;
const OTHER_BLOG = `at://${AUTHOR}/site.standard.publication/essays`;

const SESSION = { did: READER } as Session;
const URL = 'https://api.example/api/v2/documents/batch';

function testEnv(): Env {
  return {
    ...(env as unknown as Env),
    FEED_PROXY_URL: 'https://proxy.example',
    FEED_PROXY_SECRET: 'test-secret',
  } as Env;
}

function request(documents: unknown[]): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents }),
  });
}

// Capture what the proxy was asked for, and echo each requested scope back the
// way the real proxy does.
function stubProxy(): { forwarded: Array<{ did: string; siteUri?: string }> } {
  const captured: { forwarded: Array<{ did: string; siteUri?: string }> } = { forwarded: [] };
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as {
      authors: Array<{ did: string; siteUri?: string }>;
    };
    captured.forwarded = body.authors;
    return new Response(
      JSON.stringify({
        authors: body.authors.map((d) => ({
          did: d.did,
          siteUri: d.siteUri,
          documents: [],
          status: 'ready',
          complete: true,
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  return captured;
}

async function setTarget(did: string, publication: string | null) {
  await env.DB.prepare(
    `INSERT INTO user_settings (user_did, linkblog_publication, linkblog_content_format, created_at, updated_at)
     VALUES (?, ?, 'leaflet', unixepoch(), unixepoch())
     ON CONFLICT(user_did) DO UPDATE SET linkblog_publication = excluded.linkblog_publication`
  )
    .bind(did, publication)
    .run();
}

async function subscribe(userDid: string, subjectDid: string, feedUrl: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO subscriptions_cache
     (user_did, record_uri, feed_url, title, created_at, source_type, subject_did)
     VALUES (?, ?, ?, 'Their links', unixepoch(), 'atproto.documents', ?)`
  )
    .bind(
      userDid,
      `at://${userDid}/app.skyreader.feed.subscription/${feedUrl.split('/').pop()}`,
      feedUrl,
      subjectDid
    )
    .run();
}

async function authors(res: Response) {
  return (await res.json()) as { authors: Array<{ did: string; siteUri?: string }> };
}

describe('linkblog scope correction in the document batch', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await env.DB.prepare('DELETE FROM subscriptions_cache WHERE user_did = ?').bind(READER).run();
    for (const did of [READER, AUTHOR]) {
      await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(did).run();
      await env.DB.prepare(
        'INSERT OR IGNORE INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
      )
        .bind(did, `${did.split(':').pop()}.test`, 'https://test.pds.example')
        .run();
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('re-points a follower still scoped to the author’s Skyreader publication', async () => {
    await setTarget(AUTHOR, CONNECTED);
    const proxy = stubProxy();

    const res = await handleV2BatchDocumentFetch(
      request([{ did: AUTHOR, siteUri: publicationUri(AUTHOR) }]),
      testEnv(),
      SESSION
    );

    expect(proxy.forwarded).toEqual([{ did: AUTHOR, siteUri: CONNECTED }]);
    // …and the response still speaks the client's language.
    expect((await authors(res)).authors[0].siteUri).toBe(publicationUri(AUTHOR));
  });

  it('re-points a follower left on a previously-connected publication', async () => {
    // A → B → C: the D1 row was migrated to C, the device still asks for B.
    await setTarget(AUTHOR, NEXT);
    await subscribe(READER, AUTHOR, NEXT);
    const proxy = stubProxy();

    const res = await handleV2BatchDocumentFetch(
      request([{ did: AUTHOR, siteUri: CONNECTED }]),
      testEnv(),
      SESSION
    );

    expect(proxy.forwarded).toEqual([{ did: AUTHOR, siteUri: NEXT }]);
    expect((await authors(res)).authors[0].siteUri).toBe(CONNECTED);
  });

  it('leaves an ordinary publication subscription alone', async () => {
    // The reader follows this author's essays, not their linkblog. Nothing about
    // the linkblog target should re-point it.
    await setTarget(AUTHOR, CONNECTED);
    await subscribe(READER, AUTHOR, OTHER_BLOG);
    const proxy = stubProxy();

    await handleV2BatchDocumentFetch(
      request([{ did: AUTHOR, siteUri: OTHER_BLOG }]),
      testEnv(),
      SESSION
    );

    expect(proxy.forwarded).toEqual([{ did: AUTHOR, siteUri: OTHER_BLOG }]);
  });

  it('leaves the user’s own dual-scope linkblog pull alone', async () => {
    // myLinkblogStore asks for target + default on purpose; collapsing them would
    // leave one scope forever unresolved (and never "complete").
    await setTarget(READER, `at://${READER}/site.standard.publication/mine`);
    const proxy = stubProxy();

    await handleV2BatchDocumentFetch(
      request([
        { did: READER, siteUri: `at://${READER}/site.standard.publication/mine` },
        { did: READER, siteUri: publicationUri(READER) },
      ]),
      testEnv(),
      SESSION
    );

    expect(proxy.forwarded.map((d) => d.siteUri)).toEqual([
      `at://${READER}/site.standard.publication/mine`,
      publicationUri(READER),
    ]);
  });

  it('does not collapse two scopes the client asked for explicitly', async () => {
    await setTarget(AUTHOR, CONNECTED);
    const proxy = stubProxy();

    await handleV2BatchDocumentFetch(
      request([
        { did: AUTHOR, siteUri: publicationUri(AUTHOR) },
        { did: AUTHOR, siteUri: CONNECTED },
      ]),
      testEnv(),
      SESSION
    );

    expect(proxy.forwarded.map((d) => d.siteUri)).toEqual([publicationUri(AUTHOR), CONNECTED]);
  });
});
