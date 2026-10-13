import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
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
