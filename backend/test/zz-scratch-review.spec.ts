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
      share.firstSeenAt === undefined ? Date.now() - 15_000 : share.firstSeenAt
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

async function doSql<T = Record<string, unknown>>(q: string, ...args: unknown[]): Promise<T[]> {
  return runInDurableObject(percolatorStub(env), (_i, state) =>
    state.storage.sql.exec(q, ...(args as SqlStorageValue[])).toArray()
  ) as Promise<T[]>;
}

describe('scratch review', () => {
  afterEach(() => vi.restoreAllMocks());

  it('A: a stored article is ignored once the pass R2 budget is spent', async () => {
    const user = await createUser();
    await followsInEverything(user, true);
    await subscribe(user, FEED_A);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'zeppelin' });
    await settle();

    const url = uniqueUrl('stored');
    // Already read for someone else: done, text in R2.
    await doSql(
      `INSERT INTO link_bodies (url_normalized, url, state, waiters, requested_at, next_at, settled_at)
       VALUES (?, ?, 'done', '[]', ?, ?, ?)`,
      url,
      url,
      Date.now(),
      Date.now(),
      Date.now()
    );
    await env.ITEM_BODIES.put(await linkBodyKey(url), 'all about the zeppelin');
    // 50 stored feed bodies in the same page spend the pass R2 budget.
    for (let i = 0; i < 50; i++) {
      const g = await ingest(FEED_A, { title: `n${i}`, content: 'x', bodyStored: true });
      await env.ITEM_BODIES.put(await itemBodyKey(FEED_A, g), '<p>nothing</p>');
    }
    stubExtract({});
    await addShare(user, { url, text: 'look', cardTitle: 'Airships' });
    await drain();
    await drain();
    const rows = await matchedKeys(user, uuid);
    console.log('A matched', rows);
    expect(rows).toEqual([]); // bug: the article would have matched
  });

  it('E: a D1 failure during the re-check loses the article match for good', async () => {
    const user = await createUser();
    await followsInEverything(user, true);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'quokka' });
    await settle();
    const url = uniqueUrl('recheck');
    stubExtract({ [url]: '<p>the quokka smiles</p>' });
    const proto = Object.getPrototypeOf(env.DB);
    const orig = proto.batch;
    let thrown = 0;
    const spy = vi.spyOn(proto, 'batch').mockImplementation(function (
      this: unknown,
      stmts: unknown
    ) {
      if (
        thrown === 0 &&
        JSON.stringify(
          (stmts as { statement?: string }[]).map((s) => (s as any).statement ?? '')
        ).includes('INSERT INTO channel_matches')
      ) {
        thrown++;
        return Promise.reject(new Error('D1 transient'));
      }
      return orig.call(this, stmts);
    });
    await addShare(user, { url, text: 'cute', cardTitle: 'Animals' });
    await drain();
    spy.mockRestore();
    await drain();
    await drain();
    const state = await doSql<{ state: string; waiters: string }>(
      `SELECT state, waiters FROM link_bodies WHERE url_normalized = ?`,
      url
    );
    console.log('E thrown', thrown, 'state', state, 'matched', await matchedKeys(user, uuid));
    expect(thrown).toBe(1);
    expect(await matchedKeys(user, uuid)).toEqual([]);
  });

  it('F: a non-blocked refusal (EPUB, 404) is tried twice', async () => {
    const user = await createUser();
    await followsInEverything(user, true);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'wombat' });
    await settle();
    const url = uniqueUrl('epub');
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)).url);
      return Response.json({ epub: true });
    });
    await addShare(user, { url, text: 'book' });
    await drain();
    await doSql(`UPDATE link_bodies SET next_at = 0 WHERE url_normalized = ?`, url);
    await drain();
    console.log('F calls', calls.length);
    expect(calls.length).toBe(2);
  });

  it('C: an existing done query covering follows never sees pre-column shares; toggling in_everything never backfills', async () => {
    const user = await createUser();
    await followsInEverything(user, false);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'narwhal' });
    await drain();
    expect((await savedQuery(user, uuid))?.backfill_state).toBe('done');
    await addShare(user, {
      url: uniqueUrl('nar'),
      text: 'narwhal',
      firstSeenAt: Date.now() - 60_000,
    });
    await followsInEverything(user, true);
    await drain();
    console.log('C', (await savedQuery(user, uuid))?.backfill_state, await matchedKeys(user, uuid));
    expect(await matchedKeys(user, uuid)).toEqual([]);
  });

  it('D: body_skipped stays 1 after the article is read and matches', async () => {
    const user = await createUser();
    await followsInEverything(user, true);
    const uuid = newUuid();
    await putChannel(user, uuid, { query: 'pangolin' });
    await settle();
    const day = Math.floor(Date.now() / DAY);
    await doSql(
      `INSERT INTO extract_budget (user_did, day, used) VALUES (?, ?, ?)`,
      user.did,
      day,
      LINK_EXTRACTIONS_PER_READER_PER_DAY
    );
    const url = uniqueUrl('pang');
    stubExtract({ [url]: '<p>pangolin pangolin</p>' });
    await addShare(user, { url, cardTitle: 'Pangolin' });
    await drain();
    await doSql(`DELETE FROM extract_budget WHERE user_did = ?`, user.did);
    await addShare(user, { url, text: 'again' });
    await drain();
    const r = await env.DB.prepare(
      `SELECT body_skipped, snippet FROM channel_matches WHERE user_did = ?`
    )
      .bind(user.did)
      .first();
    const lb = await doSql(`SELECT state FROM link_bodies WHERE url_normalized = ?`, url);
    console.log('D', r, lb);
  });
});
