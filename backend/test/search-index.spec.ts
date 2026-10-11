import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runDurableObjectAlarm,
} from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { parseSearchQuery } from '../src/services/search-query';
import { htmlToText } from '../src/utils/html-text';
import { splitSnippet } from '../src/durable-objects/search-index';
import { itemBodyKey } from '../src/routes/item-bodies';
import {
  CURSOR_LAG_MS,
  SEARCH_ENABLED_KEY,
  ZERO_CURSORS,
  collectChangedKeys,
  searchIndexStub,
} from '../src/services/search-index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Seeded rows sit comfortably behind the cursor lag, so a sync passes them.
const SETTLED_SEC = Math.floor(Date.now() / 1000) - 3600;
const FEED = 'https://blog.example/feed.xml';

let userSeq = 0;

interface TestUser {
  did: string;
  sessionId: string;
}

async function createUser(tier: 'free' | 'supporter' = 'supporter'): Promise<TestUser> {
  userSeq++;
  // A fresh DID per test, so each test gets its own index Durable Object.
  const did = `did:plc:search${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `search-session-${did}`;
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

async function setSearchSwitch(value: string | null) {
  if (value === null) {
    await env.DB.prepare(`DELETE FROM sync_state WHERE key = ?`).bind(SEARCH_ENABLED_KEY).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(SEARCH_ENABLED_KEY, value)
    .run();
}

async function subscribe(user: TestUser, feedUrl = FEED) {
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, source_type, active)
     VALUES (?, ?, ?, ?, 'rss', 1)`
  )
    .bind(
      user.did,
      `at://${user.did}/app.skyreader.feed.subscription/${feedUrl.length}`,
      feedUrl,
      'Blog'
    )
    .run();
}

async function ingest(guid: string, item: Record<string, unknown>, feedUrl = FEED) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO feeds (feed_url, title) VALUES (?, 'The Example Blog')`
  )
    .bind(feedUrl)
    .run();
  await env.DB.prepare(
    `INSERT INTO feed_items (feed_url, guid, item_json, published_at, first_seen_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      feedUrl,
      guid,
      JSON.stringify({ guid, url: `https://blog.example/${guid}`, publishedAt: '', ...item }),
      Date.now(),
      Date.now(),
      `hash-${guid}`
    )
    .run();
}

async function addLabel(
  user: TestUser,
  itemKey: string,
  label: 'read' | 'highlights',
  props: Record<string, unknown>,
  opts: { itemType?: string; updatedAt?: number } = {}
) {
  await env.DB.prepare(
    `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.did,
      itemKey,
      opts.itemType ?? 'article',
      label,
      JSON.stringify(props),
      `rk-${label}-${itemKey}`,
      opts.updatedAt ?? SETTLED_SEC,
      opts.updatedAt ?? SETTLED_SEC,
      (opts.updatedAt ?? SETTLED_SEC) * 1000
    )
    .run();
}

async function markRead(user: TestUser, guid: string, extra: Record<string, unknown> = {}) {
  await addLabel(user, guid, 'read', {
    readAt: SETTLED_SEC * 1000,
    itemUrl: `https://blog.example/${guid}`,
    itemTitle: `Title of ${guid}`,
    ...extra,
  });
}

async function save(
  user: TestUser,
  opts: { rkey: string; url: string; title: string; content: string; itemGuid?: string }
) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, title, content, saved_at, source, item_guid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.did,
      opts.rkey,
      `at://${user.did}/app.skyreader.feed.saved/${opts.rkey}`,
      opts.url,
      opts.url,
      opts.title,
      opts.content,
      SETTLED_SEC * 1000,
      opts.itemGuid ? 'feed' : 'url',
      opts.itemGuid ?? null
    )
    .run();
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

interface SearchResultBody {
  terms: string[];
  results: {
    itemKey: string;
    itemType: string;
    url: string | null;
    title: string;
    feedTitle: string | null;
    read: boolean;
    saved: boolean;
    highlighted: boolean;
    snippet: { text: string; match: boolean }[];
  }[];
  total: number;
  totalCapped: boolean;
  index: { items: number; building: boolean };
}

async function search(user: TestUser, query: string, extra = ''): Promise<SearchResultBody> {
  const response = await call(user, `/api/search?q=${encodeURIComponent(query)}${extra}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SearchResultBody;
}

describe('parseSearchQuery', () => {
  it('quotes every term so FTS5 operators are literal', () => {
    expect(parseSearchQuery('climate AND policy')?.match).toBe('"climate" "AND" "policy"');
    expect(parseSearchQuery('title:foo NEAR(bar)')?.match).toBe('"title:foo" "NEAR(bar)"');
  });

  it('keeps phrases, prefixes and exclusions', () => {
    expect(parseSearchQuery('"carbon tax" levy* -opinion')?.match).toBe(
      '"carbon tax" "levy"* NOT "opinion"'
    );
    expect(parseSearchQuery('"carbon tax" levy* -opinion')?.terms).toEqual(['carbon tax', 'levy']);
  });

  it('tolerates unbalanced quotes and stray stars', () => {
    expect(parseSearchQuery('"unfinished phrase')?.match).toBe('"unfinished phrase"');
    expect(parseSearchQuery('it"s')?.match).toBe('"its"');
    expect(parseSearchQuery('a* ***')?.match).toBe('"a"');
  });

  it('puts exclusions after the positive terms', () => {
    expect(parseSearchQuery('-"x" ok')?.match).toBe('"ok" NOT "x"');
  });

  it('returns null when nothing searchable remains', () => {
    expect(parseSearchQuery('')).toBeNull();
    expect(parseSearchQuery('   — … !!')).toBeNull();
    expect(parseSearchQuery('-only -negatives')).toBeNull();
  });
});

describe('htmlToText', () => {
  it('drops markup and scripts, keeps block breaks, decodes entities', () => {
    const html =
      '<p>Hello&nbsp;<b>world</b> &amp; friends</p><script>evil()</script><p>Second &#8212; para&#x2026;</p>';
    expect(htmlToText(html)).toBe('Hello world & friends\nSecond — para…');
  });

  it('truncates at a word boundary', () => {
    expect(htmlToText('<p>alpha beta gamma delta</p>', 12)).toBe('alpha beta');
  });

  it('strips control characters', () => {
    expect(htmlToText('a\u0002b\u0003c')).toBe('a b c');
  });
});

describe('splitSnippet', () => {
  it('splits marked runs', () => {
    expect(splitSnippet('the \u0002climate\u0003 bill …')).toEqual([
      { text: 'the ', match: false },
      { text: 'climate', match: true },
      { text: ' bill …', match: false },
    ]);
  });
});

describe('collectChangedKeys cursor lag', () => {
  it('indexes recent rows but does not pass them', async () => {
    const user = await createUser();
    await markRead(user, 'settled-guid');
    const nowSec = Math.floor(Date.now() / 1000);
    await addLabel(user, 'recent-guid', 'read', { readAt: Date.now() }, { updatedAt: nowSec });

    const page = await collectChangedKeys(env, user.did, ZERO_CURSORS, 100);
    expect(page.keys.sort()).toEqual(['recent-guid', 'settled-guid']);
    expect(page.unsettled).toBe(true);
    // The cursor stops at the settled row, so the recent one is seen again.
    expect(page.cursors.labels.updatedAt).toBe(SETTLED_SEC);

    const later = await collectChangedKeys(
      env,
      user.did,
      page.cursors,
      100,
      Date.now() + CURSOR_LAG_MS + 2000
    );
    expect(later.keys).toEqual(['recent-guid']);
    expect(later.unsettled).toBe(false);
  });
});

describe('GET /api/search', () => {
  beforeEach(async () => {
    await setSearchSwitch('1');
  });

  it('is invisible while the operator switch is off', async () => {
    await setSearchSwitch(null);
    const user = await createUser();
    expect((await call(user, '/api/search?q=anything')).status).toBe(404);
  });

  it('is a Supporter feature', async () => {
    const user = await createUser('free');
    const response = await call(user, '/api/search?q=anything');
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('upgrade_required');
  });

  it('rejects an empty query and an unknown kind', async () => {
    const user = await createUser();
    expect((await call(user, '/api/search?q=%20%22')).status).toBe(400);
    expect((await call(user, '/api/search?q=x&kind=starred')).status).toBe(400);
  });

  it('finds read items by their body and returns a marked snippet', async () => {
    const user = await createUser();
    await subscribe(user);
    await ingest('g-heat', {
      title: 'Summer notes',
      author: 'Ada',
      content: '<p>The <em>urban heat island</em> effect raises night temperatures.</p>',
    });
    await ingest('g-other', { title: 'Unrelated', content: '<p>Gardening tips.</p>' });
    await markRead(user, 'g-heat');
    await markRead(user, 'g-other');

    const body = await search(user, 'urban heat');
    expect(body.results).toHaveLength(1);
    const hit = body.results[0];
    expect(hit).toMatchObject({
      itemKey: 'g-heat',
      title: 'Summer notes',
      feedTitle: 'The Example Blog',
      url: 'https://blog.example/g-heat',
      read: true,
      saved: false,
      highlighted: false,
    });
    expect(hit.snippet.filter((s) => s.match).map((s) => s.text)).toEqual(['urban', 'heat']);
    expect(body.index).toEqual({ items: 2, building: false });
    expect(body.terms).toEqual(['urban', 'heat']);
  });

  it('stems, ranks title matches first, and filters by kind', async () => {
    const user = await createUser();
    await subscribe(user);
    await ingest('g-body', {
      title: 'Weekly links',
      content: '<p>Notes on glaciers retreating.</p>',
    });
    await ingest('g-title', { title: 'Glacier retreat', content: '<p>A short post.</p>' });
    await markRead(user, 'g-body');
    await markRead(user, 'g-title');
    await save(user, {
      rkey: 'save1',
      url: 'https://elsewhere.example/ice',
      title: 'Ice sheets',
      content: '<p>Why the glacier matters.</p>',
    });

    const all = await search(user, 'glacier');
    expect(all.total).toBe(3);

    // Among read items a title match outranks a body match. (Across kinds the
    // saved/highlighted boost can win in a corpus this small, where every item
    // matches and bm25 is near zero.)
    const read = await search(user, 'glacier', '&kind=read');
    expect(read.results.map((r) => r.itemKey)).toEqual(['g-title', 'g-body']);

    const savedOnly = await search(user, 'glacier', '&kind=saved');
    expect(savedOnly.results).toHaveLength(1);
    expect(savedOnly.results[0]).toMatchObject({
      itemKey: `at://${user.did}/app.skyreader.feed.saved/save1`,
      itemType: 'saved',
      saved: true,
      read: false,
    });
  });

  it('indexes highlight text and notes, and the full body of a highlighted item from R2', async () => {
    const user = await createUser();
    await subscribe(user);
    const longBody = `<p>${'filler words here '.repeat(400)}</p><p>The conclusion mentions permafrost.</p>`;
    await ingest('g-long', {
      title: 'Long read',
      contentTruncated: true,
      bodyStored: true,
      contentLead: '<p>filler words here</p>',
    });
    await env.ITEM_BODIES.put(await itemBodyKey(FEED, 'g-long'), longBody);
    await markRead(user, 'g-long');

    // Read only: just the opening is indexed, so the ending isn't findable.
    expect((await search(user, 'permafrost')).results).toHaveLength(0);

    await addLabel(
      user,
      'g-long',
      'highlights',
      {
        highlights: [
          {
            id: 'h1',
            selector: { type: 'TextQuoteSelector', exact: 'filler words' },
            note: 'reminds me of tundra',
            createdAt: SETTLED_SEC * 1000,
          },
        ],
      },
      { updatedAt: SETTLED_SEC + 1 }
    );

    const permafrost = await search(user, 'permafrost');
    expect(permafrost.results).toHaveLength(1);
    expect(permafrost.results[0]).toMatchObject({ itemKey: 'g-long', highlighted: true });
    expect((await search(user, 'tundra')).results[0]?.itemKey).toBe('g-long');
  });

  it('files a highlight on a save under the guid the save bridges to', async () => {
    const user = await createUser();
    await subscribe(user);
    await ingest('g-bridge', { title: 'Bridged', content: '<p>Original body.</p>' });
    await save(user, {
      rkey: 'save-b',
      url: 'https://blog.example/g-bridge',
      title: 'Bridged',
      content: '<p>Saved body about lighthouses.</p>',
      itemGuid: 'g-bridge',
    });
    // The saved-list reader keys highlights by the save's URI.
    await addLabel(user, `at://${user.did}/app.skyreader.feed.saved/save-b`, 'highlights', {
      highlights: [{ id: 'h', selector: { exact: 'lighthouses' }, createdAt: SETTLED_SEC * 1000 }],
    });

    const body = await search(user, 'lighthouses');
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ itemKey: 'g-bridge', saved: true, highlighted: true });
  });

  it('keeps title and URL for a read item whose feed is gone', async () => {
    const user = await createUser();
    await markRead(user, 'orphan', { itemTitle: 'Quarterly fisheries report' });
    const body = await search(user, 'fisheries');
    expect(body.results[0]).toMatchObject({
      itemKey: 'orphan',
      title: 'Quarterly fisheries report',
      url: 'https://blog.example/orphan',
    });
  });

  it('drops an item marked unread, and a deleted save, through the write routes', async () => {
    const user = await createUser();
    await subscribe(user);
    await ingest('g-unread', { title: 'Volcano diary', content: '<p>Lava.</p>' });
    await markRead(user, 'g-unread');
    await save(user, {
      rkey: '3ksavedvolcano1',
      url: 'https://elsewhere.example/volcano',
      title: 'Volcano saved',
      content: '<p>Ash cloud.</p>',
    });
    expect((await search(user, 'volcano')).total).toBe(2);

    expect(
      (
        await call(user, '/api/reading/mark-unread', {
          method: 'POST',
          body: { itemGuid: 'g-unread' },
        })
      ).status
    ).toBe(200);
    expect((await call(user, '/api/saved/3ksavedvolcano1', { method: 'DELETE' })).status).toBe(200);

    const body = await search(user, 'volcano');
    expect(body.total).toBe(0);
    expect(body.index.items).toBe(0);
  });

  it('a write nudges the index onto an alarm that syncs it', async () => {
    const user = await createUser();
    await subscribe(user);
    await ingest('g-nudge', { title: 'Tidal energy', content: '<p>Turbines.</p>' });
    await markRead(user, 'g-nudge');

    // Any successful label write nudges; mark-read of another item will do.
    expect(
      (
        await call(user, '/api/reading/mark-read', {
          method: 'POST',
          body: { itemGuid: 'g-other', itemUrl: 'https://x.example', itemTitle: 'Other' },
        })
      ).status
    ).toBe(200);

    const stub = searchIndexStub(env, user.did);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const stats = await stub.stats();
    expect(stats.did).toBe(user.did);
    expect(stats.indexedItems).toBe(2);
  });

  it('does not nudge for a reader without search', async () => {
    const user = await createUser('free');
    await call(user, '/api/reading/mark-read', {
      method: 'POST',
      body: { itemGuid: 'g', itemUrl: 'https://x.example', itemTitle: 'T' },
    });
    const stub = searchIndexStub(env, user.did);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect((await stub.stats()).did).toBeNull();
  });

  it('backfills a history larger than one round', async () => {
    const user = await createUser();
    const statements = [];
    for (let i = 0; i < 350; i++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at)
           VALUES (?, ?, 'article', 'read', ?, ?, ?, ?)`
        ).bind(
          user.did,
          `bulk-${i}`,
          JSON.stringify({ readAt: SETTLED_SEC * 1000, itemTitle: `Backfill item ${i} estuary` }),
          `rk-bulk-${i}`,
          SETTLED_SEC,
          SETTLED_SEC - (i % 5)
        )
      );
    }
    await env.DB.batch(statements);

    const stub = searchIndexStub(env, user.did);
    await stub.nudge(user.did);
    for (let i = 0; i < 10 && (await runDurableObjectAlarm(stub)); i++) {
      // drain
    }
    const stats = await stub.stats();
    expect(stats.indexedItems).toBe(350);
    expect(stats.backlog).toBe(false);
    const body = await search(user, 'estuary');
    expect(body.total).toBe(350);
    expect(body.index.building).toBe(false);
  });

  it('reset rebuilds the index from zero', async () => {
    const user = await createUser();
    await markRead(user, 'g-reset', { itemTitle: 'Coral bleaching' });
    expect((await search(user, 'coral')).total).toBe(1);
    const stub = searchIndexStub(env, user.did);
    await stub.reset();
    expect((await stub.stats()).indexedItems).toBe(0);
    expect((await search(user, 'coral')).total).toBe(1);
  });
});
