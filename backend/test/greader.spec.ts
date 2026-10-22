import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DOC_ID_BASE,
  handleGReader,
  greaderSubpath,
  longItemId,
  parseItemId,
  parseStreamId,
} from '../src/routes/greader';
import { handleAppPasswords } from '../src/routes/app-passwords';
import { createAppPassword, MAX_APP_PASSWORDS } from '../src/services/app-passwords';
import { ARTICLE_WINDOW_PER_FEED } from '../src/config/window';
import { MAX_DOCUMENTS_PER_AUTHOR } from '../src/services/standard-site';
import { documentHtml } from '../src/services/document-html';
import { GRANULAR_SCOPES } from '../src/routes/auth';
import type { Session } from '../src/types';

const DID = 'did:plc:greader1';
const OTHER_DID = 'did:plc:greader2';
const HANDLE = 'reader.bsky.social';
const FEED_A = 'https://example.com/a.xml';
const FEED_B = 'https://example.com/b.xml';
const FEED_OTHER = 'https://example.com/other.xml';
const NEWSLETTER = 'newsletter:inbox1/news@example.com';

const SESSION: Session = {
  did: DID,
  handle: HANDLE,
  pdsUrl: 'https://pds.test',
  accessToken: 'tok',
  refreshToken: 'rtok',
  dpopPrivateKey: '{}',
  expiresAt: Date.now() + 3_600_000,
  grantedScopes: GRANULAR_SCOPES,
};

let password = '';

async function addUser(did: string, handle: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (did, handle, pds_url) VALUES (?, ?, 'https://pds.test')`
  )
    .bind(did, handle)
    .run();
}

async function addSubscription(
  did: string,
  feedUrl: string,
  opts: { active?: number; sourceType?: string | null; category?: string; title?: string } = {}
) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, source_type, active, category)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      did,
      `at://${did}/app.skyreader.feed.subscription/${Math.random().toString(36).slice(2)}`,
      feedUrl,
      opts.title ?? 'Feed',
      opts.sourceType ?? null,
      opts.active ?? 1,
      opts.category ?? null
    )
    .run();
}

/** Insert `count` items into a feed, oldest first; returns their seqs in the same order. */
async function addItems(feedUrl: string, count: number, prefix = feedUrl): Promise<number[]> {
  const seqs: number[] = [];
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i++) {
    const guid = `${prefix}#${i}`;
    const publishedMs = base + i * 60_000;
    const row = await env.DB.prepare(
      `INSERT INTO feed_items (feed_url, guid, item_json, published_at, first_seen_at, content_hash)
       VALUES (?, ?, ?, ?, ?, 'h') RETURNING seq`
    )
      .bind(
        feedUrl,
        guid,
        JSON.stringify({
          guid,
          url: `https://example.com/post/${encodeURIComponent(guid)}`,
          title: `Post ${i}`,
          content: `<p>Body ${i}</p>`,
          publishedAt: new Date(publishedMs).toISOString(),
        }),
        publishedMs,
        publishedMs
      )
      .first<{ seq: number }>();
    seqs.push(row!.seq);
  }
  return seqs;
}

async function call(
  path: string,
  opts: { method?: string; form?: Record<string, string | string[]>; auth?: string | null } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  const auth = opts.auth === undefined ? password : opts.auth;
  if (auth) headers.Authorization = `GoogleLogin auth=${auth}`;
  let body: string | undefined;
  if (opts.form) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.form)) {
      for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
    }
    body = params.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const request = new Request(`https://api.example/api/greader/${path}`, {
    method: opts.method ?? (opts.form ? 'POST' : 'GET'),
    headers,
    body,
  });
  const ctx = createExecutionContext();
  const response = await handleGReader(
    request,
    env,
    ctx,
    greaderSubpath(new URL(request.url).pathname)!
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function itemIds(
  params: Record<string, string>
): Promise<{ ids: number[]; continuation?: string }> {
  const res = await call(`reader/api/0/stream/items/ids?${new URLSearchParams(params)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { itemRefs: Array<{ id: string }>; continuation?: string };
  return { ids: body.itemRefs.map((r) => Number(r.id)), continuation: body.continuation };
}

const UNREAD = { s: 'user/-/state/com.google/reading-list', xt: 'user/-/state/com.google/read' };

beforeEach(async () => {
  // Storage persists across this file's tests; start each from nothing.
  await env.DB.batch(
    [
      'DELETE FROM app_passwords',
      'DELETE FROM subscriptions_cache',
      'DELETE FROM feed_items',
      'DELETE FROM documents_v2',
      'DELETE FROM item_labels_cache',
      'DELETE FROM saved_articles',
      'DELETE FROM sessions',
      'DELETE FROM rate_limits',
    ].map((sql) => env.DB.prepare(sql))
  );
  await addUser(DID, HANDLE);
  await addUser(OTHER_DID, 'other.bsky.social');
  password = (await createAppPassword(env, DID, 'NetNewsWire'))!.password;
});

describe('ids and streams', () => {
  it('parses every item id form clients send', () => {
    expect(parseItemId('12345')).toBe(12345);
    expect(parseItemId(longItemId(12345))).toBe(12345);
    expect(longItemId(255)).toBe('tag:google.com,2005:reader/item/00000000000000ff');
    expect(parseItemId('tag:google.com,2005:reader/item/zz')).toBeNull();
    expect(parseItemId('0')).toBeNull();
    expect(parseItemId('abc')).toBeNull();
  });

  it('parses stream ids', () => {
    expect(parseStreamId('user/-/state/com.google/reading-list')).toEqual({ kind: 'reading-list' });
    expect(parseStreamId('user/1005/state/com.google/starred')).toEqual({ kind: 'starred' });
    expect(parseStreamId('user/-/label/Tech')).toEqual({ kind: 'label', label: 'Tech' });
    expect(parseStreamId(`feed/${FEED_A}`)).toEqual({ kind: 'feed', feedUrl: FEED_A });
    expect(parseStreamId('user/-/state/com.google/broadcast')).toBeNull();
  });

  it('answers under both prefixes', () => {
    expect(greaderSubpath('/api/greader/reader/api/0/token')).toBe('reader/api/0/token');
    expect(greaderSubpath('/api/greader.php/accounts/ClientLogin')).toBe('accounts/ClientLogin');
    expect(greaderSubpath('/api/greaderx/token')).toBeNull();
  });
});

describe('sign-in', () => {
  it('signs in with the handle and an app password', async () => {
    const res = await call('accounts/ClientLogin', {
      form: { Email: `@${HANDLE.toUpperCase()}`, Passwd: password.replace(/-/g, '') },
      auth: null,
    });
    expect(res.status).toBe(200);
    const auth = /Auth=(.+)/.exec(await res.text())![1];
    expect((await call('reader/api/0/user-info', { auth })).status).toBe(200);
  });

  it('refuses a wrong name, a wrong password and a revoked one', async () => {
    const wrongName = await call('accounts/ClientLogin', {
      form: { Email: 'someone.else', Passwd: password },
      auth: null,
    });
    expect(wrongName.status).toBe(401);
    const wrongPassword = await call('accounts/ClientLogin', {
      form: { Email: HANDLE, Passwd: 'aaaa-bbbb-cccc-dddd-eeee' },
      auth: null,
    });
    expect(wrongPassword.status).toBe(401);

    await env.DB.prepare('DELETE FROM app_passwords WHERE user_did = ?').bind(DID).run();
    expect((await call('reader/api/0/user-info')).status).toBe(401);
  });

  it('takes the password only from a POST body', async () => {
    const query = new URLSearchParams({ Email: HANDLE, Passwd: password });
    const res = await call(`accounts/ClientLogin?${query}`, { auth: null });
    expect(res.status).toBe(405);
  });

  it('throttles guessing on API calls by IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await call('reader/api/0/user-info', { auth: 'aaaa-bbbb-cccc-dddd-eeee' })).status
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('refuses a call without the GoogleLogin header', async () => {
    expect((await call('reader/api/0/subscription/list', { auth: null })).status).toBe(401);
  });

  it('records when a password was last used', async () => {
    await call('reader/api/0/user-info');
    const row = await env.DB.prepare('SELECT last_used_at FROM app_passwords WHERE user_did = ?')
      .bind(DID)
      .first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).toBeGreaterThan(0);
  });
});

describe('subscriptions', () => {
  it('lists active feed subscriptions with folders, including newsletters', async () => {
    await addSubscription(DID, FEED_A, { category: 'Tech', title: 'Feed A' });
    await addSubscription(DID, NEWSLETTER, { sourceType: 'email.newsletter', title: 'News' });
    await addSubscription(DID, FEED_B, { active: 0 });
    await addSubscription(DID, 'at://did:plc:x/site.standard.publication/y', {
      sourceType: 'atproto.documents',
    });
    await addSubscription(OTHER_DID, FEED_OTHER);

    const res = await call('reader/api/0/subscription/list?output=json');
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string; title: string; categories: Array<{ id: string }> }>;
    };
    expect(body.subscriptions.map((s) => s.id).sort()).toEqual(
      [`feed/${FEED_A}`, `feed/${NEWSLETTER}`].sort()
    );
    const a = body.subscriptions.find((s) => s.id === `feed/${FEED_A}`)!;
    expect(a.title).toBe('Feed A');
    expect(a.categories).toEqual([{ id: 'user/-/label/Tech', label: 'Tech' }]);

    const tags = (await (await call('reader/api/0/tag/list')).json()) as {
      tags: Array<{ id: string }>;
    };
    expect(tags.tags.map((t) => t.id)).toContain('user/-/label/Tech');
  });

  it('leaves subscription editing to Skyreader', async () => {
    const res = await call('reader/api/0/subscription/quickadd', { form: { quickadd: FEED_B } });
    expect(res.status).toBe(501);
  });
});

describe('items and read state', () => {
  it('serves the newest-K window of subscribed feeds only', async () => {
    await addSubscription(DID, FEED_A);
    await addSubscription(OTHER_DID, FEED_OTHER);
    const seqs = await addItems(FEED_A, ARTICLE_WINDOW_PER_FEED + 2);
    await addItems(FEED_OTHER, 3);

    const { ids } = await itemIds({ ...UNREAD, n: '10000' });
    expect(ids).toHaveLength(ARTICLE_WINDOW_PER_FEED);
    // Newest first; the two oldest fell out of the window.
    expect(ids[0]).toBe(seqs[seqs.length - 1]);
    expect(ids).not.toContain(seqs[0]);
    expect(ids).not.toContain(seqs[1]);
  });

  it('pages with a continuation', async () => {
    await addSubscription(DID, FEED_A);
    const seqs = await addItems(FEED_A, 5);
    const first = await itemIds({ ...UNREAD, n: '3' });
    expect(first.ids).toEqual([seqs[4], seqs[3], seqs[2]]);
    const second = await itemIds({ ...UNREAD, n: '3', c: first.continuation! });
    expect(second.ids).toEqual([seqs[1], seqs[0]]);
    expect(second.continuation).toBeUndefined();
  });

  it('marks read and unread with edit-tag, shared with the web app', async () => {
    await addSubscription(DID, FEED_A, { category: 'Tech' });
    const seqs = await addItems(FEED_A, 3);

    const res = await call('reader/api/0/edit-tag', {
      form: {
        T: 'token',
        i: [longItemId(seqs[0]), String(seqs[1])],
        a: 'user/-/state/com.google/read',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');

    const labels = await env.DB.prepare(
      `SELECT item_key FROM item_labels_cache
        WHERE user_did = ? AND label = 'read' AND item_type = 'article' AND deleted_at IS NULL`
    )
      .bind(DID)
      .all<{ item_key: string }>();
    expect(labels.results.map((r) => r.item_key).sort()).toEqual([`${FEED_A}#0`, `${FEED_A}#1`]);
    expect((await itemIds(UNREAD)).ids).toEqual([seqs[2]]);

    const counts = (await (await call('reader/api/0/unread-count')).json()) as {
      unreadcounts: Array<{ id: string; count: number }>;
    };
    expect(counts.unreadcounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `feed/${FEED_A}`, count: 1 }),
        expect.objectContaining({ id: 'user/-/label/Tech', count: 1 }),
        expect.objectContaining({ id: 'user/-/state/com.google/reading-list', count: 1 }),
      ])
    );

    await call('reader/api/0/edit-tag', {
      form: { i: String(seqs[0]), r: 'user/-/state/com.google/read' },
    });
    expect((await itemIds(UNREAD)).ids).toEqual([seqs[2], seqs[0]]);
  });

  it("can't write read state for a feed the reader doesn't follow", async () => {
    await addSubscription(OTHER_DID, FEED_OTHER);
    const [seq] = await addItems(FEED_OTHER, 1);
    await call('reader/api/0/edit-tag', {
      form: { i: String(seq), a: 'user/-/state/com.google/read' },
    });
    const row = await env.DB.prepare('SELECT 1 FROM item_labels_cache WHERE user_did = ?')
      .bind(DID)
      .first();
    expect(row).toBeNull();
  });

  it('returns contents with read state, and nothing from unfollowed feeds', async () => {
    await addSubscription(DID, FEED_A, { title: 'Feed A' });
    await addSubscription(OTHER_DID, FEED_OTHER);
    const [seq] = await addItems(FEED_A, 1);
    const [otherSeq] = await addItems(FEED_OTHER, 1);
    await call('reader/api/0/edit-tag', {
      form: { i: String(seq), a: 'user/-/state/com.google/read' },
    });

    const res = await call('reader/api/0/stream/items/contents', {
      form: { i: [longItemId(seq), String(otherSeq)] },
    });
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        title: string;
        categories: string[];
        summary: { content: string };
        origin: { streamId: string; title: string };
        alternate: Array<{ href: string }>;
      }>;
    };
    expect(body.items).toHaveLength(1);
    const [item] = body.items;
    expect(item.id).toBe(longItemId(seq));
    expect(item.title).toBe('Post 0');
    expect(item.summary.content).toBe('<p>Body 0</p>');
    expect(item.categories).toContain('user/-/state/com.google/read');
    expect(item.origin).toEqual(
      expect.objectContaining({ streamId: `feed/${FEED_A}`, title: 'Feed A' })
    );
    expect(item.alternate[0].href).toContain('https://example.com/post/');
  });

  it('serves stream/contents for a feed named in the path', async () => {
    await addSubscription(DID, FEED_A);
    await addSubscription(DID, FEED_B);
    const seqs = await addItems(FEED_A, 3);
    await addItems(FEED_B, 2);
    const res = await call(
      `reader/api/0/stream/contents/${encodeURIComponent(`feed/${FEED_A}`)}?n=2&r=o`
    );
    const body = (await res.json()) as { items: Array<{ id: string }>; continuation: string };
    expect(body.items.map((i) => i.id)).toEqual([longItemId(seqs[0]), longItemId(seqs[1])]);
    const next = await call(
      `reader/api/0/stream/contents/${encodeURIComponent(`feed/${FEED_A}`)}?n=2&r=o&c=${body.continuation}`
    );
    const rest = (await next.json()) as { items: Array<{ id: string }>; continuation?: string };
    expect(rest.items.map((i) => i.id)).toEqual([longItemId(seqs[2])]);
    expect(rest.continuation).toBeUndefined();
  });

  it('marks the whole reading list read, including items read before', async () => {
    await addSubscription(DID, FEED_A);
    await addSubscription(DID, FEED_B);
    const [seqA] = await addItems(FEED_A, 1);
    await addItems(FEED_B, 1);
    await call('reader/api/0/edit-tag', {
      form: { i: String(seqA), a: 'user/-/state/com.google/read' },
    });
    const before = await env.DB.prepare(
      'SELECT client_updated_at FROM item_labels_cache WHERE user_did = ? AND item_key = ?'
    )
      .bind(DID, `${FEED_A}#0`)
      .first<{ client_updated_at: number }>();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const res = await call('reader/api/0/mark-all-as-read', {
      form: { s: 'user/-/state/com.google/reading-list' },
    });
    expect(res.status).toBe(200);
    expect((await itemIds(UNREAD)).ids).toEqual([]);
    // The earlier read is restamped: mark-all is newer intent than anything queued.
    const after = await env.DB.prepare(
      'SELECT client_updated_at FROM item_labels_cache WHERE user_did = ? AND item_key = ?'
    )
      .bind(DID, `${FEED_A}#0`)
      .first<{ client_updated_at: number }>();
    expect(after!.client_updated_at).toBeGreaterThan(before!.client_updated_at);
  });

  it('marks a stream read up to the timestamp given', async () => {
    await addSubscription(DID, FEED_A);
    const seqs = await addItems(FEED_A, 3);
    // The second item's first-seen time, in microseconds.
    const ts = (Date.UTC(2026, 0, 1) + 60_000) * 1000;
    const res = await call('reader/api/0/mark-all-as-read', {
      form: { s: `feed/${FEED_A}`, ts: String(ts) },
    });
    expect(res.status).toBe(200);
    expect((await itemIds(UNREAD)).ids).toEqual([seqs[2]]);
  });
});

describe('starred', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
       VALUES ('greader-session', ?, ?, 'https://pds.test', 'tok', 'rtok', '{}', ?, ?)`
    )
      .bind(DID, HANDLE, Date.now() + 3_600_000, GRANULAR_SCOPES)
      .run();
  });

  it('stars by saving, and unstars by removing the save', async () => {
    await addSubscription(DID, FEED_A);
    const seqs = await addItems(FEED_A, 2);

    const star = await call('reader/api/0/edit-tag', {
      form: { i: String(seqs[0]), a: 'user/-/state/com.google/starred' },
    });
    expect(star.status).toBe(200);
    const saved = await env.DB.prepare(
      'SELECT item_guid, title, source FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .all<{ item_guid: string; title: string; source: string }>();
    expect(saved.results).toEqual([{ item_guid: `${FEED_A}#0`, title: 'Post 0', source: 'feed' }]);
    expect((await itemIds({ s: 'user/-/state/com.google/starred' })).ids).toEqual([seqs[0]]);

    // Starring again is not an error.
    const again = await call('reader/api/0/edit-tag', {
      form: { i: String(seqs[0]), a: 'user/-/state/com.google/starred' },
    });
    expect(again.status).toBe(200);

    await call('reader/api/0/edit-tag', {
      form: { i: String(seqs[0]), r: 'user/-/state/com.google/starred' },
    });
    expect((await itemIds({ s: 'user/-/state/com.google/starred' })).ids).toEqual([]);
  });

  it('reports a star that could not be saved, and writes nothing else', async () => {
    await env.DB.prepare(`UPDATE sessions SET granted_scopes = 'atproto' WHERE did = ?`)
      .bind(DID)
      .run();
    await addSubscription(DID, FEED_A);
    const [seq] = await addItems(FEED_A, 1);
    const res = await call('reader/api/0/edit-tag', {
      form: { i: String(seq), a: 'user/-/state/com.google/starred' },
    });
    expect(res.status).toBe(403);
    const saved = await env.DB.prepare('SELECT 1 FROM saved_articles WHERE user_did = ?')
      .bind(DID)
      .first();
    expect(saved).toBeNull();
  });

  it('stars a large batch over several retries', async () => {
    await addSubscription(DID, FEED_A);
    const seqs = await addItems(FEED_A, 52);
    const form = { i: seqs.map(String), a: 'user/-/state/com.google/starred' };
    expect((await call('reader/api/0/edit-tag', { form })).status).toBe(503);
    expect((await call('reader/api/0/edit-tag', { form })).status).toBe(200);
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(count!.n).toBe(52);
  });

  it('needs a Skyreader session to star, and then writes nothing', async () => {
    await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
    await addSubscription(DID, FEED_A);
    const [seq] = await addItems(FEED_A, 1);
    const res = await call('reader/api/0/edit-tag', {
      form: {
        i: String(seq),
        a: ['user/-/state/com.google/starred', 'user/-/state/com.google/read'],
      },
    });
    expect(res.status).toBe(403);
    expect((await itemIds(UNREAD)).ids).toEqual([seq]);
  });
});

describe('standard.site documents', () => {
  const AUTHOR = 'did:plc:writer1';
  const PUB = `at://${AUTHOR}/site.standard.publication/blog`;
  const OTHER_PUB = `at://${AUTHOR}/site.standard.publication/notes`;
  const AUTHOR_STREAM = `feed/at://${AUTHOR}`;

  async function addDocSubscription(
    feedUrl: string,
    opts: { title?: string; category?: string } = {}
  ) {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, source_type, subject_did, active, category)
       VALUES (?, ?, ?, ?, 'atproto.documents', ?, 1, ?)`
    )
      .bind(
        DID,
        `at://${DID}/app.skyreader.feed.subscription/${Math.random().toString(36).slice(2)}`,
        feedUrl,
        opts.title ?? 'Writer',
        AUTHOR,
        opts.category ?? null
      )
      .run();
  }

  /** Insert `count` documents, oldest first; returns their item ids in the same order. */
  async function addDocuments(count: number, siteUri = PUB, prefix = 'doc'): Promise<number[]> {
    const ids: number[] = [];
    const base = Date.UTC(2026, 1, 1);
    for (let i = 0; i < count; i++) {
      const at = base + i * 60_000;
      const record = {
        $type: 'site.standard.document',
        site: siteUri,
        title: `Essay ${i}`,
        path: `/${prefix}-${i}`,
        publishedAt: new Date(at).toISOString(),
        textContent: `Plain ${i}`,
        content: {
          $type: 'pub.leaflet.content',
          pages: [
            {
              $type: 'pub.leaflet.pages.linearDocument',
              blocks: [
                {
                  block: {
                    $type: 'pub.leaflet.blocks.text',
                    plaintext: `Hello ${i}`,
                    facets: [
                      {
                        index: { byteStart: 0, byteEnd: 5 },
                        features: [{ $type: 'pub.leaflet.richtext.facet#bold' }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      };
      const row = await env.DB.prepare(
        `INSERT INTO documents_v2 (record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at)
         VALUES (?, ?, ?, 'cid', ?, ?, ?, ?, ?) RETURNING rowid`
      )
        .bind(
          `at://${AUTHOR}/site.standard.document/${prefix}${i}`,
          AUTHOR,
          `${prefix}${i}`,
          siteUri,
          at,
          `https://writer.example/${prefix}-${i}`,
          JSON.stringify(record),
          at
        )
        .first<{ rowid: number }>();
      ids.push(DOC_ID_BASE + row!.rowid);
    }
    return ids;
  }

  it('lists a followed author and publication as feeds', async () => {
    await addDocSubscription('', { title: 'Writer', category: 'Essays' });
    await addDocSubscription(PUB, { title: 'The Blog' });
    const res = await call('reader/api/0/subscription/list');
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string; title: string; categories: Array<{ label: string }> }>;
    };
    expect(body.subscriptions.map((s) => [s.id, s.title])).toEqual([
      [AUTHOR_STREAM, 'Writer'],
      [`feed/${PUB}`, 'The Blog'],
    ]);
    expect(body.subscriptions[0].categories).toEqual([
      expect.objectContaining({ label: 'Essays' }),
    ]);
  });

  it('serves documents in the reading list next to articles, newest first', async () => {
    await addSubscription(DID, FEED_A);
    const [seq] = await addItems(FEED_A, 1);
    await addDocSubscription(PUB);
    const docs = await addDocuments(2);
    await addDocuments(1, OTHER_PUB, 'other');
    // Articles were first seen in January, documents in February.
    expect((await itemIds(UNREAD)).ids).toEqual([docs[1], docs[0], seq]);
    expect((await itemIds({ s: `feed/${PUB}` })).ids).toEqual([docs[1], docs[0]]);
  });

  it('windows each documents subscription to what the web app serves', async () => {
    await addDocSubscription('');
    const docs = await addDocuments(MAX_DOCUMENTS_PER_AUTHOR + 2);
    const { ids } = await itemIds({ ...UNREAD, n: '10000' });
    expect(ids).toHaveLength(MAX_DOCUMENTS_PER_AUTHOR);
    expect(ids).not.toContain(docs[0]);
  });

  it('lists a document once when two subscriptions cover it', async () => {
    await addDocSubscription('');
    await addDocSubscription(PUB);
    const [doc] = await addDocuments(1);
    expect((await itemIds(UNREAD)).ids).toEqual([doc]);
    const res = await call(`reader/api/0/stream/items/contents?i=${doc}`);
    const body = (await res.json()) as { items: Array<{ origin: { streamId: string } }> };
    expect(body.items[0].origin.streamId).toBe(`feed/${PUB}`);
  });

  it('renders a document with its link back to the publication', async () => {
    await addDocSubscription(PUB, { title: 'The Blog' });
    const [doc] = await addDocuments(1);
    const res = await call(`reader/api/0/stream/items/contents?i=${longItemId(doc)}`);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        title: string;
        summary: { content: string };
        alternate: Array<{ href: string }>;
        origin: { streamId: string; title: string };
      }>;
    };
    const [item] = body.items;
    expect(item.id).toBe(longItemId(doc));
    expect(item.title).toBe('Essay 0');
    expect(item.summary.content).toBe('<p><strong>Hello</strong> 0</p>');
    expect(item.alternate[0].href).toBe('https://writer.example/doc-0');
    expect(item.origin).toEqual(
      expect.objectContaining({ streamId: `feed/${PUB}`, title: 'The Blog' })
    );
  });

  it('marks documents read as the web app does, and unread again', async () => {
    await addDocSubscription(PUB);
    const [doc, other] = await addDocuments(2);
    const res = await call('reader/api/0/edit-tag', {
      form: { i: String(doc), a: 'user/-/state/com.google/read' },
    });
    expect(res.status).toBe(200);
    const label = await env.DB.prepare(
      `SELECT item_key, item_type, props FROM item_labels_cache
        WHERE user_did = ? AND label = 'read' AND deleted_at IS NULL`
    )
      .bind(DID)
      .first<{ item_key: string; item_type: string; props: string }>();
    expect(label).toEqual(
      expect.objectContaining({
        item_key: `at://${AUTHOR}/site.standard.document/doc0`,
        item_type: 'document',
      })
    );
    expect(JSON.parse(label!.props)).toEqual(
      expect.objectContaining({
        itemUrl: 'https://writer.example/doc-0',
        itemTitle: 'Essay 0',
        authorDid: AUTHOR,
      })
    );
    expect((await itemIds(UNREAD)).ids).toEqual([other]);

    const unread = await call('reader/api/0/unread-count');
    const counts = (await unread.json()) as { unreadcounts: Array<{ id: string; count: number }> };
    expect(counts.unreadcounts).toContainEqual(
      expect.objectContaining({ id: `feed/${PUB}`, count: 1 })
    );

    await call('reader/api/0/edit-tag', {
      form: { i: String(doc), r: 'user/-/state/com.google/read' },
    });
    expect((await itemIds(UNREAD)).ids).toEqual([other, doc]);
  });

  it('marks a documents stream read', async () => {
    await addDocSubscription('');
    await addDocuments(2);
    const res = await call('reader/api/0/mark-all-as-read', { form: { s: AUTHOR_STREAM } });
    expect(res.status).toBe(200);
    expect((await itemIds(UNREAD)).ids).toEqual([]);
  });

  it("doesn't serve or mark documents of authors the reader doesn't follow", async () => {
    const [doc] = await addDocuments(1);
    expect((await itemIds(UNREAD)).ids).toEqual([]);
    await call('reader/api/0/edit-tag', {
      form: { i: String(doc), a: 'user/-/state/com.google/read' },
    });
    const label = await env.DB.prepare('SELECT 1 FROM item_labels_cache WHERE user_did = ?')
      .bind(DID)
      .first();
    expect(label).toBeNull();
    const res = await call(`reader/api/0/stream/items/contents?i=${doc}`);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('stars a document by saving it as the web app does', async () => {
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
       VALUES ('greader-session', ?, ?, 'https://pds.test', 'tok', 'rtok', '{}', ?, ?)`
    )
      .bind(DID, HANDLE, Date.now() + 3_600_000, GRANULAR_SCOPES)
      .run();
    await addDocSubscription(PUB);
    const [doc] = await addDocuments(1);
    const star = await call('reader/api/0/edit-tag', {
      form: { i: String(doc), a: 'user/-/state/com.google/starred' },
    });
    expect(star.status).toBe(200);
    const saved = await env.DB.prepare(
      'SELECT item_guid, title, source FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .all<{ item_guid: string; title: string; source: string }>();
    expect(saved.results).toEqual([
      {
        item_guid: `at://${AUTHOR}/site.standard.document/doc0`,
        title: 'Essay 0',
        source: 'document',
      },
    ]);
    expect((await itemIds({ s: 'user/-/state/com.google/starred' })).ids).toEqual([doc]);

    await call('reader/api/0/edit-tag', {
      form: { i: String(doc), r: 'user/-/state/com.google/starred' },
    });
    expect((await itemIds({ s: 'user/-/state/com.google/starred' })).ids).toEqual([]);
  });

  it('renders other formats and plain text safely', () => {
    expect(
      documentHtml(
        {
          content: {
            $type: 'pub.leaflet.content',
            pages: [
              {
                blocks: [
                  { block: { $type: 'pub.leaflet.blocks.header', level: 2, plaintext: 'A <b>' } },
                  {
                    block: {
                      $type: 'pub.leaflet.blocks.text',
                      plaintext: 'café link',
                      facets: [
                        {
                          index: { byteStart: 6, byteEnd: 10 },
                          features: [
                            {
                              $type: 'pub.leaflet.richtext.facet#link',
                              uri: 'javascript:alert(1)',
                            },
                            { $type: 'pub.leaflet.richtext.facet#italic' },
                          ],
                        },
                      ],
                    },
                  },
                  { block: { $type: 'pub.leaflet.blocks.membersOnlyDelimiter' } },
                  { block: { $type: 'pub.leaflet.blocks.text', plaintext: 'hidden' } },
                ],
              },
            ],
          },
        },
        AUTHOR
      )
    ).toBe('<h2>A &lt;b&gt;</h2>\n<p>café <em>link</em></p>');
    expect(
      documentHtml(
        {
          content: {
            $type: 'blog.pckt.content',
            items: [{ plaintext: 'One' }, { plaintext: 'Two' }],
          },
        },
        AUTHOR
      )
    ).toBe('<p>One</p>\n<p>Two</p>');
    expect(documentHtml({ textContent: 'First\n\nSecond <x>' }, AUTHOR)).toBe(
      '<p>First</p>\n<p>Second &lt;x&gt;</p>'
    );
  });
});

describe('managing app passwords', () => {
  async function manage(method: string, path = '', body?: unknown, session = SESSION) {
    return handleAppPasswords(
      new Request(`https://api.example/api/app-passwords${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      session
    );
  }

  it('creates, lists and revokes', async () => {
    const created = await manage('POST', '', { name: 'Reeder' });
    expect(created.status).toBe(201);
    const { id, password: fresh } = (await created.json()) as { id: number; password: string };
    expect(fresh).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){4}$/);

    const listing = (await (await manage('GET')).json()) as {
      passwords: Array<{ id: number; name: string }>;
      serverUrl: string;
      username: string;
    };
    expect(listing.passwords.map((p) => p.name)).toEqual(['Reeder', 'NetNewsWire']);
    expect(listing.serverUrl).toBe('https://api.example/api/greader');
    expect(listing.username).toBe(HANDLE);
    expect(JSON.stringify(listing)).not.toContain(fresh);

    // Someone else can't revoke it.
    const other = { ...SESSION, did: OTHER_DID };
    expect((await manage('DELETE', `/${id}`, undefined, other)).status).toBe(404);
    expect((await manage('DELETE', `/${id}`)).status).toBe(200);
    const login = await call('accounts/ClientLogin', {
      form: { Email: HANDLE, Passwd: fresh },
      auth: null,
    });
    expect(login.status).toBe(401);
  });

  it('caps how many a reader can have', async () => {
    for (let i = 1; i < MAX_APP_PASSWORDS; i++) {
      expect((await manage('POST', '', { name: `App ${i}` })).status).toBe(201);
    }
    expect((await manage('POST', '', { name: 'One too many' })).status).toBe(409);
  });

  it('needs a name', async () => {
    expect((await manage('POST', '', { name: '  ' })).status).toBe(400);
  });
});
