import {
  env,
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { itemBodyKey } from '../src/routes/item-bodies';
import {
  SAVED_SEARCH_ENABLED_KEY,
  extractSavedQuery,
  matchInsertStatements,
  percolatorStub,
  resolveQueryScope,
  type MatchDoc,
} from '../src/services/saved-search';
import { linkBodyKey } from '../src/services/link-bodies';
import { LINK_EXTRACTIONS_PER_READER_PER_DAY } from '../src/durable-objects/percolator';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DAY = 24 * 60 * 60 * 1000;
// Fresh feeds per test: a backfill covers everything recent in a feed, so a
// shared feed would let one test's items match another test's query.
let FEED_A = '';
let FEED_B = '';

let userSeq = 0;

interface TestUser {
  did: string;
  sessionId: string;
}

async function createUser(tier: 'free' | 'supporter' = 'supporter'): Promise<TestUser> {
  userSeq++;
  const did = `did:plc:saved${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `saved-session-${did}`;
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(did, `${did}.test`, 'https://test.pds.example', tier)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sessionId,
      did,
      `${did}.test`,
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000
    )
    .run();
  return { did, sessionId };
}

async function setSwitch(value: string | null) {
  if (value === null) {
    await env.DB.prepare(`DELETE FROM sync_state WHERE key = ?`)
      .bind(SAVED_SEARCH_ENABLED_KEY)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(SAVED_SEARCH_ENABLED_KEY, value)
    .run();
}

/** Subscribe to a feed; returns the source key the frontend would give it. */
async function subscribe(user: TestUser, feedUrl: string): Promise<string> {
  const rkey = `3k${Math.random().toString(36).slice(2, 13)}`;
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, source_type, active)
     VALUES (?, ?, ?, ?, 'rss', 1)`
  )
    .bind(user.did, `at://${user.did}/app.skyreader.feed.subscription/${rkey}`, feedUrl, 'Feed')
    .run();
  return `rss~${rkey}`;
}

async function subscribeDocuments(
  user: TestUser,
  authorDid: string,
  publication: string
): Promise<string> {
  const rkey = `3d${Math.random().toString(36).slice(2, 13)}`;
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, source_type, subject_did, active)
     VALUES (?, ?, ?, ?, 'atproto.documents', ?, 1)`
  )
    .bind(
      user.did,
      `at://${user.did}/app.skyreader.feed.subscription/${rkey}`,
      publication,
      'Docs',
      authorDid
    )
    .run();
  return `${rkey}~documents`;
}

let guidSeq = 0;

/** Ingest one feed item; returns its guid. */
async function ingest(
  feedUrl: string,
  item: { title?: string; content?: string; url?: string; bodyStored?: boolean },
  publishedAt = Date.now()
): Promise<string> {
  guidSeq++;
  const guid = `g-${guidSeq}-${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.prepare(`INSERT OR IGNORE INTO feeds (feed_url, title) VALUES (?, 'A Feed')`)
    .bind(feedUrl)
    .run();
  await env.DB.prepare(
    `INSERT INTO feed_items (feed_url, guid, item_json, published_at, first_seen_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      feedUrl,
      guid,
      JSON.stringify({
        guid,
        url: item.url ?? `${feedUrl.replace('/feed.xml', '')}/${guid}`,
        title: item.title ?? 'Untitled',
        content: item.content ?? '',
        bodyStored: item.bodyStored,
        publishedAt: new Date(publishedAt).toISOString(),
      }),
      publishedAt,
      Date.now(),
      `hash-${guid}`
    )
    .run();
  return guid;
}

async function addDocument(
  authorDid: string,
  rkey: string,
  title: string,
  text: string,
  siteUri: string
) {
  const uri = `at://${authorDid}/site.standard.document/${rkey}`;
  const now = Date.now() - 10_000; // settled past the matcher's write-clock lag
  await env.DB.prepare(
    `INSERT INTO documents_v2 (record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at)
     VALUES (?, ?, ?, 'cid', ?, ?, ?, ?, ?)`
  )
    .bind(
      uri,
      authorDid,
      rkey,
      siteUri,
      now,
      `https://docs.example/${rkey}`,
      JSON.stringify({ title, textContent: text }),
      now
    )
    .run();
  return uri;
}

async function call(
  user: TestUser,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Cookie: `session_id=${user.sessionId}`,
        Origin: 'http://localhost:5173',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

let channelSeq = 0;

function newUuid(): string {
  channelSeq++;
  return `00000000-0000-4000-8000-${String(channelSeq).padStart(12, '0')}`;
}

async function putChannel(user: TestUser, uuid: string, config: Record<string, unknown>) {
  const now = Date.now();
  const response = await call(user, `/api/channels/${uuid}`, {
    method: 'PUT',
    body: {
      name: 'Watch',
      config: JSON.stringify(config),
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
  });
  expect(response.status).toBe(200);
}

async function savedQuery(user: TestUser, uuid: string) {
  return env.DB.prepare(`SELECT * FROM saved_queries WHERE user_did = ? AND channel_uuid = ?`)
    .bind(user.did, uuid)
    .first<{ query: string; backfill_state: string; updated_at: number }>();
}

async function matchedKeys(user: TestUser, uuid: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT item_key FROM channel_matches WHERE user_did = ? AND channel_uuid = ? ORDER BY item_key`
  )
    .bind(user.did, uuid)
    .all<{ item_key: string }>();
  return (rows.results ?? []).map((r) => r.item_key);
}

/** Run passes until the matcher reports no backlog (bounded, so a bug can't hang the suite). */
async function drain() {
  for (let i = 0; i < 20; i++) {
    const outcome = await percolatorStub(env).runPass();
    if (!outcome.more) return;
  }
  throw new Error('percolator never drained');
}

/** Finish every pending backfill, then start the live cursors from the current heads. */
async function settle() {
  await percolatorStub(env).reset();
  await drain();
}

interface ItemsBody {
  status: string;
  backfilling: boolean;
  items: {
    kind: string;
    itemKey: string;
    read: boolean;
    snippet: { text: string; match: boolean }[];
    item?: { title: string; feedUrl: string };
    document?: { uri: string; title: string };
  }[];
  unread: number;
  nextCursor: string | null;
}

beforeEach(async () => {
  await setSwitch('1');
  const suffix = Math.random().toString(36).slice(2, 8);
  FEED_A = `https://a${suffix}.example/feed.xml`;
  FEED_B = `https://b${suffix}.example/feed.xml`;
});

describe('extractSavedQuery', () => {
  it('reads the query and source selection from a channel config', () => {
    const saved = extractSavedQuery(
      JSON.stringify({
        query: ' PFAS -opinion ',
        sourceMode: 'include',
        sourceKeys: ['b', 'a', 'a'],
      })
    );
    expect(saved).toEqual({
      query: 'PFAS -opinion',
      ftsQuery: '"PFAS" NOT "opinion"',
      sourceMode: 'include',
      sourceKeys: ['a', 'b'],
      digest: 'off',
    });
  });

  it('ignores channels with no searchable query, and Saved-mode channels', () => {
    expect(extractSavedQuery(JSON.stringify({ sourceMode: 'all' }))).toBeNull();
    expect(extractSavedQuery(JSON.stringify({ query: '-only' }))).toBeNull();
    expect(extractSavedQuery(JSON.stringify({ query: 'x y', mode: 'saved' }))).toBeNull();
    expect(extractSavedQuery('not json')).toBeNull();
  });

  it('drops source keys when the channel covers all sources', () => {
    expect(
      extractSavedQuery(JSON.stringify({ query: 'x', sourceMode: 'all', sourceKeys: ['a'] }))
        ?.sourceKeys
    ).toEqual([]);
  });
});

describe('resolveQueryScope', () => {
  const FEED = 'https://a.example/feed.xml';
  const subs = [
    {
      user_did: 'd',
      record_uri: 'at://d/c/r1',
      feed_url: FEED,
      source_type: 'rss',
      subject_did: null,
    },
    {
      user_did: 'd',
      record_uri: 'at://d/c/r2',
      feed_url: 'newsletter:1/x@y',
      source_type: 'newsletter',
      subject_did: null,
    },
    {
      user_did: 'd',
      record_uri: 'at://d/c/r3',
      feed_url: 'at://did:plc:author/site.standard.publication/p',
      source_type: 'atproto.documents',
      subject_did: 'did:plc:author',
    },
  ];

  it('covers every feed and publication for "all"', () => {
    const scope = resolveQueryScope('all', [], subs);
    expect([...scope.feedUrls].sort()).toEqual([FEED, 'newsletter:1/x@y'].sort());
    expect(scope.docScopes).toEqual([
      { did: 'did:plc:author', pub: 'at://did:plc:author/site.standard.publication/p' },
    ]);
  });

  it('expands the source picker group keys to their members', () => {
    const filed = subs.map((sub, i) => (i === 0 ? { ...sub, category: 'Energy' } : sub));
    const both = resolveQueryScope('include', ['group~newsletters', 'group~publications'], filed);
    expect([...both.feedUrls].sort()).toEqual([FEED, 'newsletter:1/x@y'].sort());
    expect(both.docScopes).toHaveLength(1);
    expect([...resolveQueryScope('include', ['group~newsletters'], filed).feedUrls]).toEqual([
      'newsletter:1/x@y',
    ]);
    const folder = resolveQueryScope('include', ['group~category~Energy'], filed);
    expect([...folder.feedUrls]).toEqual([FEED]);
    expect(folder.docScopes).toEqual([]);
    const bsky = [
      ...filed,
      {
        ...subs[0],
        record_uri: 'at://d/c/r4',
        feed_url: 'bsky-likes:d',
        source_type: 'bsky.likes',
      },
      {
        ...subs[0],
        record_uri: 'at://d/c/r5',
        feed_url: 'bsky-bookmarks:d',
        source_type: 'bsky.bookmarks',
      },
    ];
    expect([...resolveQueryScope('include', ['group~likes'], bsky).feedUrls]).toEqual([
      'bsky-likes:d',
    ]);
    expect([...resolveQueryScope('include', ['group~bookmarks'], bsky).feedUrls]).toEqual([
      'bsky-bookmarks:d',
    ]);
    expect([...resolveQueryScope('include', ['group~publications'], bsky).feedUrls]).toEqual([
      FEED,
    ]);
    const docsOnly = resolveQueryScope('include', ['group~documents'], bsky);
    expect([...docsOnly.feedUrls]).toEqual([]);
    expect(docsOnly.docScopes).toHaveLength(1);
    const notFeeds = resolveQueryScope('exclude', ['group~feeds'], filed);
    expect([...notFeeds.feedUrls]).toEqual(['newsletter:1/x@y']);
    expect(notFeeds.docScopes).toHaveLength(1);
  });

  it('honours include and exclude, including legacy document keys', () => {
    expect([...resolveQueryScope('include', ['rss~r1'], subs).feedUrls]).toEqual([FEED]);
    expect(resolveQueryScope('include', ['did:plc:author~documents'], subs).docScopes).toHaveLength(
      1
    );
    const excluded = resolveQueryScope('exclude', ['rss~r1', 'r3~documents'], subs);
    expect([...excluded.feedUrls]).toEqual(['newsletter:1/x@y']);
    expect(excluded.docScopes).toEqual([]);
  });
});

describe('saved queries follow channel writes', () => {
  it('creates, edits and removes the saved query with the channel', async () => {
    const user = await createUser();
    const uuid = newUuid();

    await putChannel(user, uuid, { sourceMode: 'all' });
    expect(await savedQuery(user, uuid)).toBeNull();

    await putChannel(user, uuid, { sourceMode: 'all', query: 'PFAS' });
    expect((await savedQuery(user, uuid))?.query).toBe('PFAS');

    // A digest change keeps the matches; a query change clears them and backfills again.
    await env.DB.prepare(
      `INSERT INTO channel_matches (user_did, channel_uuid, dedup_key, item_key, source_kind, source_ref, matched_at)
       VALUES (?, ?, 'k', 'g', 'feed', ?, 1)`
    )
      .bind(user.did, uuid, FEED_A)
      .run();
    await env.DB.prepare(`UPDATE saved_queries SET backfill_state = 'done' WHERE channel_uuid = ?`)
      .bind(uuid)
      .run();
    await putChannel(user, uuid, { sourceMode: 'all', query: 'PFAS', digest: 'daily' });
    expect(await matchedKeys(user, uuid)).toEqual(['g']);
    expect((await savedQuery(user, uuid))?.backfill_state).toBe('done');

    await putChannel(user, uuid, { sourceMode: 'all', query: 'forever chemicals' });
    expect(await matchedKeys(user, uuid)).toEqual([]);
    expect((await savedQuery(user, uuid))?.backfill_state).toBe('pending');

    const response = await call(user, `/api/channels/${uuid}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await savedQuery(user, uuid)).toBeNull();
  });

  it('mirrors queries from a bulk sync', async () => {
    const user = await createUser();
    const [a, b] = [newUuid(), newUuid()];
    const now = Date.now();
    const response = await call(user, '/api/channels', {
      method: 'PUT',
      body: {
        channels: [
          {
            uuid: a,
            name: 'A',
            config: JSON.stringify({ query: 'alpha' }),
            position: 0,
            createdAt: now,
            updatedAt: now,
          },
          {
            uuid: b,
            name: 'B',
            config: JSON.stringify({}),
            position: 1,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect((await savedQuery(user, a))?.query).toBe('alpha');
    expect(await savedQuery(user, b)).toBeNull();
  });
});

describe('Percolator', () => {
  it('matches new items from covered feeds on their full text', async () => {
    const user = await createUser();
    const keyA = await subscribe(user, FEED_A);
    await subscribe(user, FEED_B);
    const uuid = newUuid();
    await putChannel(user, uuid, { sourceMode: 'include', sourceKeys: [keyA], query: 'regulate' });
    await settle();

    const inBody = await ingest(FEED_A, {
      title: 'Water news',
      content: '<p>The agency announced new <b>regulations</b> on PFAS.</p>',
    });
    const longGuid = await ingest(FEED_A, {
      title: 'A long read',
      content: '<p>An opening paragraph about nothing in particular.</p>',
      bodyStored: true,
    });
    await env.ITEM_BODIES.put(
      await itemBodyKey(FEED_A, longGuid),
      '<p>An opening paragraph.</p><p>Much later, lawmakers move to regulate it.</p>'
    );
    await ingest(FEED_A, { title: 'Sports', content: '<p>Nothing to see.</p>' });
    await ingest(FEED_B, { title: 'Regulated', content: '<p>Regulators everywhere.</p>' });
    await ingest(FEED_A, { title: 'Old regulation story' }, Date.now() - 60 * DAY);

    await drain();
    expect(await matchedKeys(user, uuid)).toEqual([inBody, longGuid].sort());
  });

  it('backfills the last 30 days when a query is created', async () => {
    const user = await createUser();
    await subscribe(user, FEED_A);
    const recent = await ingest(FEED_A, { title: 'Microplastics found' }, Date.now() - 5 * DAY);
    await ingest(FEED_A, { title: 'Microplastics, again' }, Date.now() - 45 * DAY);
    await settle();

    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'microplastics' });
    expect((await savedQuery(user, uuid))?.backfill_state).toBe('pending');
    await drain();

    expect(await matchedKeys(user, uuid)).toEqual([recent]);
    expect((await savedQuery(user, uuid))?.backfill_state).toBe('done');
  });

  it('matches standard.site documents by their text', async () => {
    const user = await createUser();
    const author = `did:plc:author${Math.random().toString(36).slice(2, 8)}`;
    const publication = `at://${author}/site.standard.publication/main`;
    await subscribeDocuments(user, author, publication);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: '"soil carbon"' });
    await settle();

    const hit = await addDocument(
      author,
      'r1',
      'Farming notes',
      'Measuring soil carbon at scale.',
      publication
    );
    await addDocument(
      author,
      'r2',
      'Other notes',
      'Soil is good. Carbon is everywhere.',
      publication
    );
    // The same author's other publication isn't part of this subscription.
    await addDocument(
      author,
      'r3',
      'Elsewhere',
      'Soil carbon, but in another publication.',
      `at://${author}/site.standard.publication/other`
    );
    await drain();

    expect(await matchedKeys(user, uuid)).toEqual([hit]);
  });

  it('matches a story once per channel, however many sources carry it', async () => {
    const user = await createUser();
    await subscribe(user, FEED_A);
    await subscribe(user, FEED_B);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'merger' });
    await settle();

    const url = 'https://news.example/story?utm_source=feed';
    await ingest(FEED_A, { title: 'Merger announced', url });
    await ingest(FEED_B, { title: 'The merger', url: 'https://news.example/story' });
    await drain();

    expect(await matchedKeys(user, uuid)).toHaveLength(1);
  });

  it("doesn't match for readers whose plan excludes saved searches", async () => {
    const user = await createUser('free');
    await subscribe(user, FEED_A);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'anything' });
    await settle();
    await ingest(FEED_A, { title: 'Anything at all' });
    await drain();
    expect(await matchedKeys(user, uuid)).toEqual([]);
  });

  it('never writes hits for a query version that has since changed', async () => {
    const user = await createUser();
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'alpha' });
    const row = await savedQuery(user, uuid);
    const doc: MatchDoc = {
      kind: 'feed',
      itemKey: 'g-stale',
      sourceRef: FEED_A,
      siteUri: '',
      feedSeq: 1,
      url: null,
      title: '',
      author: '',
      sourceTitle: '',
      body: '',
      publishedAt: Date.now(),
    };
    const target = { userDid: user.did, channelUuid: uuid };
    await env.DB.batch(
      matchInsertStatements(
        env,
        [{ query: { ...target, updatedAt: row!.updated_at - 1 }, doc, snippet: '' }],
        Date.now()
      )
    );
    expect(await matchedKeys(user, uuid)).toEqual([]);
    await env.DB.batch(
      matchInsertStatements(
        env,
        [{ query: { ...target, updatedAt: row!.updated_at }, doc, snippet: '' }],
        Date.now()
      )
    );
    expect(await matchedKeys(user, uuid)).toEqual(['g-stale']);
  });
});

interface PreviewBody {
  total: number;
  scanned: number;
  capped: boolean;
  hits: { kind: string; itemKey: string; title: string; snippet: { match: boolean }[] }[];
}

describe('POST /api/channels/preview', () => {
  it('finds unread items from the selected sources only', async () => {
    const user = await createUser();
    const keyA = await subscribe(user, FEED_A);
    await subscribe(user, FEED_B);
    const hit = await ingest(FEED_A, { title: 'PFAS in rivers' });
    await ingest(FEED_A, { title: 'Something else' });
    await ingest(FEED_B, { title: 'PFAS elsewhere' });
    await ingest(FEED_A, { title: 'Old PFAS news' }, Date.now() - 40 * DAY);

    const response = await call(user, '/api/channels/preview', {
      method: 'POST',
      body: { query: 'pfas', sourceMode: 'include', sourceKeys: [keyA] },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PreviewBody;
    expect(body.scanned).toBe(2);
    expect(body.total).toBe(1);
    expect(body.capped).toBe(false);
    expect(body.hits.map((h) => h.itemKey)).toEqual([hit]);
    expect(body.hits[0].snippet.some((s) => s.match)).toBe(true);

    const all = (await (
      await call(user, '/api/channels/preview', {
        method: 'POST',
        body: { query: 'pfas', sourceMode: 'all', sourceKeys: [] },
      })
    ).json()) as PreviewBody;
    expect(all.total).toBe(2);
  });

  it('counts a story carried by two feeds once, and says when follows are left out', async () => {
    const user = await createUser();
    await subscribe(user, FEED_A);
    await subscribe(user, FEED_B);
    const url = `https://site${Math.random().toString(36).slice(2, 8)}.example/p/1`;
    await ingest(FEED_A, { title: 'PFAS story', url });
    await ingest(FEED_B, { title: 'PFAS story', url });

    const body = (await (
      await call(user, '/api/channels/preview', {
        method: 'POST',
        body: { query: 'pfas', sourceMode: 'all', sourceKeys: [] },
      })
    ).json()) as PreviewBody & { coversFollows: boolean };
    expect(body.total).toBe(1);
    expect(body.hits).toHaveLength(1);

    const follows = (await (
      await call(user, '/api/channels/preview', {
        method: 'POST',
        body: { query: 'pfas', sourceMode: 'include', sourceKeys: ['bsky~follows'] },
      })
    ).json()) as PreviewBody & { coversFollows: boolean };
    expect(follows.scanned).toBe(0);
    expect(follows.coversFollows).toBe(true);
  });

  it('refuses an empty query and readers without saved searches', async () => {
    const user = await createUser();
    const empty = await call(user, '/api/channels/preview', {
      method: 'POST',
      body: { query: '-only', sourceMode: 'all', sourceKeys: [] },
    });
    expect(empty.status).toBe(400);

    const free = await createUser('free');
    const refused = await call(free, '/api/channels/preview', {
      method: 'POST',
      body: { query: 'pfas', sourceMode: 'all', sourceKeys: [] },
    });
    expect(refused.status).toBe(403);
  });
});

describe('saving a saved search', () => {
  it('starts the look back at once, without waiting for the cron', async () => {
    const user = await createUser();
    await subscribe(user, FEED_A);
    const guid = await ingest(FEED_A, { title: 'PFAS in rivers' }, Date.now() - DAY);
    await settle();
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'pfas' });
    // The kick sets an alarm for now; the matcher runs on it, not on a pass we drive.
    await vi.waitFor(
      async () => {
        expect(await matchedKeys(user, uuid)).toEqual([guid]);
      },
      { timeout: 5000, interval: 50 }
    );
  });
});

describe('GET /api/channels/:uuid/items', () => {
  it('serves matches newest first, with snippets, read state and an unread count', async () => {
    const user = await createUser();
    await subscribe(user, FEED_A);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'pfas' });
    await settle();

    const older = await ingest(FEED_A, { title: 'PFAS in rivers' }, Date.now() - 2 * DAY);
    const newer = await ingest(FEED_A, { title: 'PFAS rules', content: '<p>New PFAS limits.</p>' });
    await drain();
    await env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
       VALUES (?, ?, 'article', 'read', '{}', 'rk', unixepoch(), unixepoch(), 0)`
    )
      .bind(user.did, older)
      .run();

    const first = await call(user, `/api/channels/${uuid}/items?limit=1`);
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as ItemsBody;
    expect(page1.status).toBe('active');
    expect(page1.items.map((i) => i.itemKey)).toEqual([newer]);
    expect(page1.items[0].item?.feedUrl).toBe(FEED_A);
    expect(page1.items[0].snippet.some((s) => s.match && /pfas/i.test(s.text))).toBe(true);
    expect(page1.unread).toBe(1);

    const second = await call(
      user,
      `/api/channels/${uuid}/items?limit=1&before=${encodeURIComponent(page1.nextCursor!)}`
    );
    const page2 = (await second.json()) as ItemsBody;
    expect(page2.items.map((i) => [i.itemKey, i.read])).toEqual([[older, true]]);
    expect(page2.nextCursor).toBeNull();
  });

  it('is hidden while the switch is off and gated on the plan', async () => {
    const user = await createUser();
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'pfas' });

    await setSwitch(null);
    expect((await call(user, `/api/channels/${uuid}/items`)).status).toBe(404);
    await setSwitch('1');

    const free = await createUser('free');
    const response = await call(free, `/api/channels/${uuid}/items`);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('upgrade_required');

    const plain = newUuid();
    await putChannel(user, plain, { sourceMode: 'all' });
    const notSaved = await call(user, `/api/channels/${plain}/items`);
    expect(notSaved.status).toBe(404);
    expect(((await notSaved.json()) as { code: string }).code).toBe('not_saved_search');
  });
});

// --- follows links -------------------------------------------------------------

let shareSeq = 0;

/** One share in the reader's follows timeline; written "now" unless told otherwise. */
async function addShare(
  user: TestUser,
  share: {
    url: string;
    text?: string;
    cardTitle?: string;
    sharer?: string;
    sharedAt?: number;
    firstSeenAt?: number | null;
  }
) {
  shareSeq++;
  const sharer = share.sharer ?? `did:plc:sharer${shareSeq}`;
  const postUri = `at://${sharer}/app.bsky.feed.post/p${shareSeq}`;
  await env.DB.prepare(
    `INSERT INTO follow_link_shares
       (user_did, post_uri, sharer_did, kind, url, url_normalized, post_text, card_title,
        sharer_handle, sharer_name, shared_at, first_seen_at)
     VALUES (?, ?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.did,
      postUri,
      sharer,
      share.url,
      share.url,
      share.text ?? null,
      share.cardTitle ?? null,
      `${sharer.slice(8)}.bsky.social`,
      `Sharer ${shareSeq}`,
      share.sharedAt ?? Date.now() - 60_000,
      // Settled past the matcher's write-clock lag.
      share.firstSeenAt === undefined ? Date.now() - 90_000 : share.firstSeenAt
    )
    .run();
  return postUri;
}

async function followsInEverything(user: TestUser, on: boolean) {
  await env.DB.prepare(
    `INSERT INTO follow_link_sync (user_did, in_everything, complete) VALUES (?, ?, 1)
     ON CONFLICT(user_did) DO UPDATE SET in_everything = excluded.in_everything`
  )
    .bind(user.did, on ? 1 : 0)
    .run();
}

/** The proxy's /extract, answering with `articles[url]`; counts its calls. */
function stubExtract(articles: Record<string, string>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.endsWith('/extract')) throw new Error(`unexpected fetch ${href}`);
    const { url } = JSON.parse(String(init?.body)) as { url: string };
    calls.push(url);
    const content = articles[url];
    return Response.json(
      content === undefined
        ? { error: 'The site refused', blocked: true }
        : { title: 'T', content, wordCount: 10 }
    );
  });
  return calls;
}

function uniqueUrl(name: string) {
  return `https://${name}${Math.random().toString(36).slice(2, 8)}.example/story`;
}

describe('Percolator: follows links', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches a share on its words at once, and on the article once it is read', async () => {
    const user = await createUser();
    const uuid = newUuid();
    await putChannel(user, uuid, {
      sourceMode: 'include',
      sourceKeys: ['bsky~follows'],
      query: 'aquifer',
    });
    await settle();

    const byWords = uniqueUrl('words');
    const byBody = uniqueUrl('body');
    const neither = uniqueUrl('neither');
    const calls = stubExtract({
      [byWords]: '<p>Unrelated.</p>',
      [byBody]: '<p>Deep in the piece: the aquifer is drying up.</p>',
      [neither]: '<p>Nothing here.</p>',
    });
    await addShare(user, { url: byWords, text: 'Worth reading on the aquifer' });
    await addShare(user, { url: byBody, text: 'Good read', cardTitle: 'Water' });
    await addShare(user, { url: neither, text: 'Something else' });
    await drain();

    expect(await matchedKeys(user, uuid)).toEqual([byBody, byWords].sort());
    // Each article was read once, and kept.
    expect(calls.sort()).toEqual([byBody, byWords, neither].sort());
    const stored = await env.ITEM_BODIES.get(await linkBodyKey(byBody));
    expect(await stored?.text()).toContain('aquifer');
  });

  it('reads an article once however many readers follow someone who shared it', async () => {
    const a = await createUser();
    const b = await createUser();
    const uuidA = newUuid();
    const uuidB = newUuid();
    for (const [user, uuid] of [
      [a, uuidA],
      [b, uuidB],
    ] as const) {
      await followsInEverything(user, true);
      await putChannel(user, uuid, { query: 'glacier' });
    }
    await settle();

    const url = uniqueUrl('shared');
    const calls = stubExtract({ [url]: '<p>The glacier retreats.</p>' });
    await addShare(a, { url, text: 'Look' });
    await addShare(b, { url, text: 'Look at this' });
    await drain();

    expect(calls).toEqual([url]);
    expect(await matchedKeys(a, uuidA)).toEqual([url]);
    expect(await matchedKeys(b, uuidB)).toEqual([url]);
  });

  it('covers follows links only where the channel takes them in', async () => {
    const hidden = await createUser();
    await followsInEverything(hidden, false);
    const allUuid = newUuid();
    await putChannel(hidden, allUuid, { query: 'tundra' });
    const excluded = await createUser();
    const exUuid = newUuid();
    await putChannel(excluded, exUuid, {
      sourceMode: 'exclude',
      sourceKeys: ['bsky~follows'],
      query: 'tundra',
    });
    await settle();

    stubExtract({});
    await addShare(hidden, { url: uniqueUrl('t1'), text: 'tundra' });
    await addShare(excluded, { url: uniqueUrl('t2'), text: 'tundra' });
    await drain();

    expect(await matchedKeys(hidden, allUuid)).toEqual([]);
    expect(await matchedKeys(excluded, exUuid)).toEqual([]);
  });

  it("matches on the card alone once the reader has spent the day's budget", async () => {
    const user = await createUser();
    await followsInEverything(user, true);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'permafrost' });
    await settle();
    const day = Math.floor(Date.now() / DAY);
    await runInDurableObject(percolatorStub(env), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO extract_budget (user_did, day, used) VALUES (?, ?, ?)`,
        user.did,
        day,
        LINK_EXTRACTIONS_PER_READER_PER_DAY
      );
    });

    const onCard = uniqueUrl('card');
    const inBody = uniqueUrl('inbody');
    const calls = stubExtract({ [inBody]: '<p>permafrost</p>' });
    await addShare(user, { url: onCard, cardTitle: 'Permafrost thaw' });
    await addShare(user, { url: inBody, text: 'read this' });
    await drain();

    expect(calls).toEqual([]);
    expect(await matchedKeys(user, uuid)).toEqual([onCard]);
    const row = await env.DB.prepare(
      `SELECT body_skipped FROM channel_matches WHERE user_did = ? AND channel_uuid = ?`
    )
      .bind(user.did, uuid)
      .first<{ body_skipped: number }>();
    expect(row?.body_skipped).toBe(1);

    // A new day: someone else shares the link, its article is read, and the
    // match no longer says it was skipped.
    await runInDurableObject(percolatorStub(env), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM extract_budget WHERE user_did = ?`, user.did);
    });
    vi.restoreAllMocks();
    stubExtract({ [onCard]: '<p>Permafrost, at length.</p>' });
    await addShare(user, { url: onCard, text: 'again' });
    await drain();
    const after = await env.DB.prepare(
      `SELECT body_skipped FROM channel_matches WHERE user_did = ? AND channel_uuid = ?`
    )
      .bind(user.did, uuid)
      .first<{ body_skipped: number }>();
    expect(after?.body_skipped).toBe(0);
  });

  it('backfills the stored week of shares, and lists who shared each story', async () => {
    const user = await createUser();
    await followsInEverything(user, true);
    await subscribe(user, FEED_A);
    const url = uniqueUrl('back');
    // Written before follows matching: no first_seen_at, so only the backfill sees them.
    await addShare(user, {
      url,
      text: 'On wetlands',
      sharer: 'did:plc:maya',
      sharedAt: Date.now() - 2 * DAY,
      firstSeenAt: null,
    });
    await addShare(user, {
      url,
      text: 'Also this',
      sharer: 'did:plc:sam',
      sharedAt: Date.now() - DAY,
      firstSeenAt: null,
    });
    await addShare(user, {
      url: uniqueUrl('old'),
      text: 'wetlands',
      sharedAt: Date.now() - 9 * DAY,
      firstSeenAt: null,
    });
    // The same story through a feed.
    await ingest(FEED_A, { title: 'Wetlands, restored', url }, Date.now() - 3 * DAY);
    await settle();
    stubExtract({});

    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'wetlands' });
    await drain();

    expect((await savedQuery(user, uuid))?.backfill_state).toBe('done');
    const response = await call(user, `/api/channels/${uuid}/items`);
    const body = (await response.json()) as {
      items: {
        kind: string;
        itemKey: string;
        sharedBy: { did: string }[];
        sharedByCount: number;
      }[];
    };
    // One story: the feed matched first, and both follows who shared it are listed.
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe('feed');
    expect(body.items[0].sharedBy.map((s) => s.did).sort()).toEqual([
      'did:plc:maya',
      'did:plc:sam',
    ]);
    expect(body.items[0].sharedByCount).toBe(2);
  });

  it('serves a story only follows shared as a link', async () => {
    const user = await createUser();
    await followsInEverything(user, true);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'estuary' });
    await settle();
    const url = uniqueUrl('link');
    stubExtract({});
    await addShare(user, { url, text: 'The estuary', cardTitle: 'Tides' });
    await drain();

    const body = (await (await call(user, `/api/channels/${uuid}/items`)).json()) as {
      items: { kind: string; link?: { url: string; title: string; urlNormalized: string } }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe('follows');
    expect(body.items[0].link).toMatchObject({ url, title: 'Tides', urlNormalized: url });
  });
});
