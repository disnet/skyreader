import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES, LINKBLOG_SCOPES } from '../src/config/scopes';

// Changing page visibility is a linkblog mutation, so it's gated on the linkblog
// scopes like the rest of them.
const GRANTED_SCOPES = [GRANULAR_SCOPES, ...LINKBLOG_SCOPES].join(' ');

// Connecting a linkblog to an existing publication gives the same posts two public
// homes: the connected publication's own site, and the page Skyreader renders at
// linkblogs.skyreader.app. Most people want both (the Skyreader page is a stable
// DID-keyed address with its own RSS feed, and it survives switching publications),
// but it's a choice, so there's a switch for it.
//
// The invariants that matter here:
//  - Turning the page off is only possible WITH a connected publication. Without
//    one that page is the only public address the links have, and hiding it would
//    be a second, quieter way to spell "delete".
//  - Coming back to the Skyreader linkblog clears the choice, by either route
//    (the UI's disconnect, or a connect aimed at the default publication).
//  - The public site reads one flag, and a deleted linkblog reads as hidden too.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const TEST_DID = 'did:plc:pagevisibility';
const TEST_SESSION_ID = 'test-session-page-visibility';
const LEAFLET_URI = `at://${TEST_DID}/site.standard.publication/my-leaflet`;
const DEFAULT_URI = `at://${TEST_DID}/site.standard.publication/skyreader-links`;

const SECOND_URI = `at://${TEST_DID}/site.standard.publication/other-leaflet`;
const FOLLOWER_DID = 'did:plc:pagevisibilityreader';
const LINKBLOG_PAGE = `https://linkblogs.skyreader.app/${TEST_DID}/`;

const PUBLICATIONS = [
  { uri: LEAFLET_URI, cid: 'bafy1', value: { name: 'Field Notes', url: 'https://leaflet.pub/me' } },
  {
    uri: SECOND_URI,
    cid: 'bafy3',
    value: { name: 'Second Notes', url: 'https://leaflet.pub/me-again' },
  },
  {
    uri: DEFAULT_URI,
    cid: 'bafy2',
    value: { name: 'My links', url: `https://linkblogs.skyreader.app/${TEST_DID}` },
  },
];

function makeAuthRequest(path: string, opts?: { method?: string; body?: unknown }) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      Cookie: `session_id=${TEST_SESSION_ID}`,
      'Content-Type': 'application/json',
      Origin: env.FRONTEND_URL,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function send(request: Request) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request as never, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// What the public linkblog site sees: it has no session, just the DID.
async function resolved(): Promise<{ siteUri: string; hidden: boolean }> {
  const res = await send(new IncomingRequest(`http://localhost/api/linkblog/resolve/${TEST_DID}`));
  expect(res.status).toBe(200);
  return (await res.json()) as { siteUri: string; hidden: boolean };
}

async function storedPageHidden(): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT linkblog_page_hidden FROM user_settings WHERE user_did = ?'
  )
    .bind(TEST_DID)
    .first<{ linkblog_page_hidden: number }>();
  return row?.linkblog_page_hidden ?? null;
}

// Someone subscribed to this author's linkblog. `siteUrl` is how their reader
// tells a linkblog from an ordinary publication (see sourceDisplay), and it's
// also the link they'd click.
async function seedFollower(feedUrl: string, siteUrl: string | null) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
  )
    .bind(FOLLOWER_DID, 'reader.test', 'https://test.pds.example')
    .run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO subscriptions_cache
     (user_did, record_uri, feed_url, title, site_url, created_at, source_type, subject_did, active)
     VALUES (?, ?, ?, ?, ?, unixepoch(), 'atproto.documents', ?, 1)`
  )
    .bind(
      FOLLOWER_DID,
      `at://${FOLLOWER_DID}/app.skyreader.feed.subscription/3kfollowerrkey`,
      feedUrl,
      'Their links',
      siteUrl,
      TEST_DID
    )
    .run();
}

async function followerRow(): Promise<{ feed_url: string; site_url: string | null } | null> {
  return env.DB.prepare(
    'SELECT feed_url, site_url FROM subscriptions_cache WHERE user_did = ? AND subject_did = ?'
  )
    .bind(FOLLOWER_DID, TEST_DID)
    .first<{ feed_url: string; site_url: string | null }>();
}

function stubPds() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('listRecords')) {
      const collection = new URL(url).searchParams.get('collection');
      return new Response(
        JSON.stringify({
          records: collection === 'site.standard.publication' ? PUBLICATIONS : [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('getRecord')) {
      const rkey = new URL(url).searchParams.get('rkey');
      const record = PUBLICATIONS.find((p) => p.uri.endsWith(`/${rkey}`));
      if (!record) return new Response(JSON.stringify({ error: 'NotFound' }), { status: 404 });
      return new Response(JSON.stringify(record), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // The delete path: with no documents listed above there's nothing to purge but
    // the publication record itself.
    if (url.includes('deleteRecord') || url.includes('applyWrites')) {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function connect(publicationUri: string) {
  const res = await send(
    makeAuthRequest('/api/linkblog/publication/connect', {
      method: 'PUT',
      body: { publicationUri },
    })
  );
  expect(res.status).toBe(200);
  return res;
}

async function setPageHidden(pageHidden: boolean) {
  return send(
    makeAuthRequest('/api/linkblog/publication/visibility', {
      method: 'PUT',
      body: { pageHidden },
    })
  );
}

describe('the Skyreader linkblog page switch', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    for (const [table, column] of [
      ['user_settings', 'user_did'],
      ['sessions', 'did'],
      ['users', 'did'],
    ]) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(TEST_DID).run();
    }
    await env.DB.prepare('DELETE FROM subscriptions_cache WHERE subject_did = ?')
      .bind(TEST_DID)
      .run();
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(FOLLOWER_DID).run();
    await env.DB.prepare(
      'INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
    )
      .bind(TEST_DID, 'visibility.test', 'https://test.pds.example')
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        TEST_SESSION_ID,
        TEST_DID,
        'visibility.test',
        'https://test.pds.example',
        'test-access-token',
        'test-refresh-token',
        JSON.stringify(TEST_DPOP_KEY),
        Date.now() + 3600000,
        GRANTED_SCOPES
      )
      .run();
    stubPds();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders the page by default', async () => {
    expect(await resolved()).toEqual({
      siteUri: DEFAULT_URI,
      defaultSiteUri: DEFAULT_URI,
      hidden: false,
    });
  });

  it('refuses to hide the page when there is no connected publication', async () => {
    const res = await setPageHidden(true);
    expect(res.status).toBe(400);
    expect(await storedPageHidden()).not.toBe(1);
    expect((await resolved()).hidden).toBe(false);
  });

  it('hides the page once a publication is connected, and unhides it again', async () => {
    await connect(LEAFLET_URI);

    const hide = await setPageHidden(true);
    expect(hide.status).toBe(200);
    expect(((await hide.json()) as { pageHidden: boolean }).pageHidden).toBe(true);
    expect((await resolved()).hidden).toBe(true);

    const show = await setPageHidden(false);
    expect(show.status).toBe(200);
    expect(((await show.json()) as { pageHidden: boolean }).pageHidden).toBe(false);
    expect((await resolved()).hidden).toBe(false);
  });

  it('restores the page when the user disconnects', async () => {
    await connect(LEAFLET_URI);
    expect((await setPageHidden(true)).status).toBe(200);

    const res = await send(
      makeAuthRequest('/api/linkblog/publication/connect', { method: 'DELETE' })
    );
    expect(res.status).toBe(200);
    expect(await storedPageHidden()).toBe(0);
    expect((await resolved()).hidden).toBe(false);
  });

  // The UI routes "back to the Skyreader linkblog" through DELETE, but the API is
  // open and a connect aimed at the default publication means the same thing.
  it('restores the page when the default publication is selected through connect', async () => {
    await connect(LEAFLET_URI);
    expect((await setPageHidden(true)).status).toBe(200);

    await connect(DEFAULT_URI);
    expect(await storedPageHidden()).toBe(0);
    expect((await resolved()).hidden).toBe(false);
  });

  // Belt and braces for the row above: however a stale `1` gets there, it must not
  // dark a linkblog whose only public address is the page it would hide.
  it('ignores a stored hide with no connected publication', async () => {
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, linkblog_page_hidden, created_at, updated_at)
       VALUES (?, 1, unixepoch(), unixepoch())
       ON CONFLICT(user_did) DO UPDATE SET linkblog_page_hidden = 1`
    )
      .bind(TEST_DID)
      .run();

    expect(await storedPageHidden()).toBe(1);
    expect((await resolved()).hidden).toBe(false);
  });

  it('reads a deleted linkblog as hidden too', async () => {
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, linkblog_disabled, created_at, updated_at)
       VALUES (?, 1, unixepoch(), unixepoch())
       ON CONFLICT(user_did) DO UPDATE SET linkblog_disabled = 1`
    )
      .bind(TEST_DID)
      .run();

    expect((await resolved()).hidden).toBe(true);
  });

  // Deleting takes the connection with it, so the choice that only existed
  // alongside that connection goes too. Otherwise it lies in wait: restore, connect
  // something else, and the page is dark again without anyone asking for it.
  it('clears the choice when the linkblog is deleted', async () => {
    await connect(LEAFLET_URI);
    expect((await setPageHidden(true)).status).toBe(200);

    const res = await send(makeAuthRequest('/api/linkblog/publication', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(await storedPageHidden()).toBe(0);
  });

  // Every other linkblog mutation gates on the linkblog scopes; a session that
  // can't publish shouldn't be managing where the publishing shows up.
  it('requires the linkblog scopes', async () => {
    await connect(LEAFLET_URI);
    await env.DB.prepare('UPDATE sessions SET granted_scopes = ? WHERE session_id = ?')
      .bind(GRANULAR_SCOPES, TEST_SESSION_ID)
      .run();

    expect((await setPageHidden(true)).status).toBe(403);
    expect(await storedPageHidden()).not.toBe(1);
  });

  // The page URL is stored on every follower's subscription, and it outlives the
  // moment we stored it. Whatever the switch says has to reach those rows too, or
  // the reader is left holding a link to a page we've stopped serving.
  describe('the people already subscribed', () => {
    it('drops the page URL when the author turns the page off, and puts it back', async () => {
      await connect(LEAFLET_URI);
      await seedFollower(LEAFLET_URI, LINKBLOG_PAGE);

      expect((await setPageHidden(true)).status).toBe(200);
      expect((await followerRow())?.site_url).toBeNull();

      expect((await setPageHidden(false)).status).toBe(200);
      expect((await followerRow())?.site_url).toBe(LINKBLOG_PAGE);
    });

    // Only ours. A reader who set their own address for this source keeps it.
    it('leaves a reader-set address alone', async () => {
      await connect(LEAFLET_URI);
      await seedFollower(LEAFLET_URI, 'https://leaflet.pub/me');

      expect((await setPageHidden(true)).status).toBe(200);
      expect((await followerRow())?.site_url).toBe('https://leaflet.pub/me');
    });

    // The switching path heals followers' missing siteUrl while it moves the graph
    // edge. With the page off, that heal would write a URL that 404s.
    it('does not heal a missing page URL while the page is off', async () => {
      await connect(LEAFLET_URI);
      expect((await setPageHidden(true)).status).toBe(200);
      await seedFollower(LEAFLET_URI, null);

      await connect(SECOND_URI);

      const row = await followerRow();
      expect(row?.feed_url).toBe(SECOND_URI);
      expect(row?.site_url).toBeNull();
    });

    // ...but coming back to the Skyreader linkblog makes the page live again
    // whatever the stored flag says, so the heal is right again.
    it('heals the page URL when the author comes back to the default publication', async () => {
      await connect(LEAFLET_URI);
      expect((await setPageHidden(true)).status).toBe(200);
      await seedFollower(LEAFLET_URI, null);

      await connect(DEFAULT_URI);

      const row = await followerRow();
      expect(row?.feed_url).toBe(DEFAULT_URI);
      expect(row?.site_url).toBe(LINKBLOG_PAGE);
    });
  });

  it('rejects a non-boolean body', async () => {
    const res = await send(
      makeAuthRequest('/api/linkblog/publication/visibility', {
        method: 'PUT',
        body: { pageHidden: 'yes' },
      })
    );
    expect(res.status).toBe(400);
  });
});
