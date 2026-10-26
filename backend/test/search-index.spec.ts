import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index';
import { parseSearchQuery } from '../src/services/search-query';
import { htmlToText } from '../src/utils/html-text';
import {
  MAX_PASSAGES,
  PASSAGE_STRIDE,
  passageSpans,
  splitSnippet,
} from '../src/durable-objects/search-index';
import { itemBodyKey } from '../src/routes/item-bodies';
import {
  BOOK_BODY_CHARS,
  CURSOR_LAG_MS,
  SEARCH_ENABLED_KEY,
  ZERO_CURSORS,
  buildIndexDocs,
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
  opts: {
    rkey: string;
    url: string;
    title: string;
    content: string;
    itemGuid?: string;
    contentType?: 'pdf' | 'epub';
  }
) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, title, content, saved_at, source, item_guid, content_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      opts.itemGuid ?? null,
      opts.contentType ?? null
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
        Origin: 'https://skyreader.app',
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

/** FTS5's own check that each index agrees with the text it was built from. */
async function expectIndexConsistent(user: TestUser) {
  await runInDurableObject(searchIndexStub(env, user.did), (_instance, state) => {
    for (const table of ['fts', 'notes_fts', 'passages_fts']) {
      state.storage.sql.exec(`INSERT INTO ${table} (${table}, rank) VALUES ('integrity-check', 1)`);
    }
  });
}

async function search(user: TestUser, query: string, extra = ''): Promise<SearchResultBody> {
  const response = await call(user, `/api/search?q=${encodeURIComponent(query)}${extra}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SearchResultBody;
}

describe('parseSearchQuery', () => {
  const parse = (q: string) => {
    const parsed = parseSearchQuery(q);
    return parsed && { positives: parsed.positives, negatives: parsed.negatives };
  };

  it('quotes every term so FTS5 operators are literal', () => {
    expect(parse('climate AND policy')?.positives).toEqual(['"climate"', '"AND"', '"policy"']);
    expect(parse('title:foo NEAR(bar)')?.positives).toEqual(['"title:foo"', '"NEAR(bar)"']);
  });

  it('keeps phrases, prefixes and exclusions', () => {
    expect(parse('"carbon tax" levy* -opinion')).toEqual({
      positives: ['"carbon tax"', '"levy"*'],
      negatives: ['"opinion"'],
    });
    expect(parseSearchQuery('"carbon tax" levy* -opinion')?.terms).toEqual(['carbon tax', 'levy']);
  });

  it('tolerates unbalanced quotes and stray stars', () => {
    expect(parse('"unfinished phrase')?.positives).toEqual(['"unfinished phrase"']);
    expect(parse('it"s')?.positives).toEqual(['"its"']);
    expect(parse('a* ***')?.positives).toEqual(['"a"']);
    expect(parse('-"x" ok')).toEqual({ positives: ['"ok"'], negatives: ['"x"'] });
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

describe('passageSpans', () => {
  // What SQLite's substr() returns for a span: it counts characters.
  const bySqlite = (text: string, start: number, len: number) =>
    Array.from(text)
      .slice(start, start + len)
      .join('');

  it('covers the text in overlapping passages cut at spaces', () => {
    const text = 'word '.repeat(3000); // 15k chars
    const spans = passageSpans(text);
    expect(spans[0].from).toBe(0);
    expect(spans[spans.length - 1].to).toBe(text.length);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].from).toBeLessThan(spans[i - 1].to); // overlaps
      expect(text[spans[i].from]).toBe('w'); // starts on a word
      expect(spans[i - 1].to - spans[i - 1].from).toBeLessThanOrEqual(4000);
    }
  });

  it('still overlaps text with no spaces, so a word cut at one end is whole in the next', () => {
    const text = '日本語の文章'.repeat(2000); // 12k chars, no whitespace
    const spans = passageSpans(text);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i - 1].to - spans[i].from).toBe(400);
    }
    expect(spans[spans.length - 1].to).toBe(text.length);
  });

  it('never makes more passages than an item has rowids for', () => {
    expect(MAX_PASSAGES).toBeLessThanOrEqual(PASSAGE_STRIDE);
    // Spaces just past the halfway point make every cut as early as it can be.
    const worst = `${'x'.repeat(2001)} `.repeat(Math.ceil(BOOK_BODY_CHARS / 2002));
    for (const text of [worst.slice(0, BOOK_BODY_CHARS), 'y'.repeat(BOOK_BODY_CHARS)]) {
      expect(passageSpans(text).length).toBeLessThanOrEqual(MAX_PASSAGES);
    }
  });

  it('gives character offsets that select the same text in SQLite', () => {
    const text = `${'a 😀 b '.repeat(1500)}${'😀'.repeat(3000)}`;
    for (const span of passageSpans(text)) {
      expect(bySqlite(text, span.start, span.len)).toBe(text.slice(span.from, span.to));
    }
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

  it('indexes a whole saved book, but only the first 64k of a saved web page', async () => {
    const user = await createUser();
    const filler = `<p>${'chapter text goes on '.repeat(4000)}</p>`; // ~84k chars
    await save(user, {
      rkey: '3ksavedbook0001',
      url: 'https://books.example/novel.epub',
      title: 'A novel',
      content: `${filler}<p>The epilogue is set in Reykjavik.</p>`,
      contentType: 'epub',
    });
    await save(user, {
      rkey: '3ksavedpage0001',
      url: 'https://web.example/long-page',
      title: 'A long page',
      content: `${filler}<p>The footer mentions Reykjavik.</p>`,
    });
    const body = await search(user, 'reykjavik');
    expect(body.results.map((r) => r.itemKey)).toEqual([
      `at://${user.did}/app.skyreader.feed.saved/3ksavedbook0001`,
    ]);
  });

  it('snippets a long book from the passage that matches, and drops it cleanly', async () => {
    const user = await createUser();
    // Emoji ahead of the match: passages are cut in characters, as SQLite counts them.
    const filler = `<p>${'quiet 😀 garden morning '.repeat(4000)}</p>`; // ~96k chars
    await save(user, {
      rkey: '3ksavedbook0002',
      url: 'https://books.example/long.pdf',
      title: 'A long report',
      content: `${filler}<p>The appendix covers Svalbard in detail.</p>${filler}`,
      contentType: 'pdf',
    });
    await env.DB.prepare(`UPDATE saved_articles SET author = 'Ingrid Lindqvist' WHERE rkey = ?`)
      .bind('3ksavedbook0002')
      .run();
    // A highlight, filed under the save's URI, keeps the whole book indexed.
    await addLabel(
      user,
      `at://${user.did}/app.skyreader.feed.saved/3ksavedbook0002`,
      'highlights',
      { highlights: [{ id: 'h', selector: { exact: 'quiet' }, createdAt: SETTLED_SEC * 1000 }] },
      { updatedAt: SETTLED_SEC + 1 }
    );
    const body = await search(user, 'svalbard');
    expect(body.total).toBe(1);
    expect(body.results[0]).toMatchObject({ highlighted: true, saved: true });

    // Rebuilding it with the version the index holds doesn't load the text again.
    const key = `at://${user.did}/app.skyreader.feed.saved/3ksavedbook0002`;
    const first = await buildIndexDocs(env, user.did, [key]);
    expect(first.upserts[0].bodyVersion).toBeTruthy();
    const again = await buildIndexDocs(env, user.did, [key], () => first.upserts[0].bodyVersion);
    expect(again.upserts[0].body).toBeNull();

    // A second highlight later keeps the book's text, and the note is searchable.
    await env.DB.prepare(
      `UPDATE item_labels_cache SET props = ?, updated_at = ? WHERE user_did = ? AND item_key = ?`
    )
      .bind(
        JSON.stringify({
          highlights: [
            { id: 'h', selector: { exact: 'quiet' }, createdAt: SETTLED_SEC * 1000 },
            {
              id: 'h2',
              selector: { exact: 'garden' },
              note: 'walrus',
              createdAt: SETTLED_SEC * 1000,
            },
          ],
        }),
        SETTLED_SEC + 2,
        user.did,
        key
      )
      .run();
    expect((await search(user, 'svalbard walrus')).total).toBe(1);
    await expectIndexConsistent(user);
    expect(body.results[0].snippet).toContainEqual({ text: 'Svalbard', match: true });
    expect(body.results[0].snippet.map((s) => s.text).join('')).toContain('appendix covers');
    // A title-only match still gets a snippet.
    expect((await search(user, 'report')).results[0].snippet).toContainEqual({
      text: 'report',
      match: true,
    });
    // So does an author-only match.
    expect((await search(user, 'lindqvist')).results[0].snippet).toContainEqual({
      text: 'Lindqvist',
      match: true,
    });
    // A page past the last match still reports the total.
    const past = await search(user, 'svalbard', '&offset=5');
    expect(past.results).toHaveLength(0);
    expect(past.total).toBe(1);

    expect((await call(user, '/api/saved/3ksavedbook0002', { method: 'DELETE' })).status).toBe(200);
    // Still highlighted, so still indexed, but its text went with the save.
    const after = await search(user, 'svalbard');
    expect(after.total).toBe(0);
    expect(after.index.items).toBe(1);
    await expectIndexConsistent(user);
  });

  it('builds kept text again when its row went away during the build', async () => {
    const user = await createUser();
    await save(user, {
      rkey: '3ksavedgone0001',
      url: 'https://books.example/gone.pdf',
      title: 'A vanishing report',
      content: '<p>The appendix covers Svalbard in detail.</p>',
      contentType: 'pdf',
    });
    const key = `at://${user.did}/app.skyreader.feed.saved/3ksavedgone0001`;
    const first = await buildIndexDocs(env, user.did, [key]);
    const version = first.upserts[0].bodyVersion;
    // Built as though the index held the text, then written to an index that doesn't.
    const kept = await buildIndexDocs(env, user.did, [key], () => version);
    expect(kept.upserts[0].body).toBeNull();
    await runInDurableObject(searchIndexStub(env, user.did), (instance, state) => {
      const apply = (instance as unknown as { apply(b: typeof kept): string[] }).apply.bind(
        instance
      );
      expect(apply(kept)).toEqual([key]);
      expect(state.storage.sql.exec(`SELECT count(*) AS n FROM docs`).one().n).toBe(0);
    });
    expect((await search(user, 'svalbard')).total).toBe(1);
  });

  it('versions only text built from the save itself', async () => {
    const user = await createUser();
    // Extracts to nothing, so the body falls back to the description.
    await save(user, {
      rkey: '3ksavedlead0001',
      url: 'https://blog.example/lead',
      title: 'Only a lead',
      content: '<script>tracking()</script>',
    });
    await env.DB.prepare(`UPDATE saved_articles SET description = 'About walruses' WHERE rkey = ?`)
      .bind('3ksavedlead0001')
      .run();
    const built = await buildIndexDocs(env, user.did, [
      `at://${user.did}/app.skyreader.feed.saved/3ksavedlead0001`,
    ]);
    expect(built.upserts[0].body).toContain('walruses');
    expect(built.upserts[0].bodyVersion).toBeNull();
  });

  it('ranks an item matched partly through a note on its own text too', async () => {
    const user = await createUser();
    await save(user, {
      rkey: '3ksavedrank0001',
      url: 'https://web.example/keynes',
      title: 'Keynes and the general theory',
      content: '<p>A chapter on employment.</p>',
    });
    await addLabel(
      user,
      `at://${user.did}/app.skyreader.feed.saved/3ksavedrank0001`,
      'highlights',
      {
        highlights: [
          {
            id: 'h',
            selector: { exact: 'employment' },
            note: 'liquidity',
            createdAt: SETTLED_SEC * 1000,
          },
        ],
      },
      { updatedAt: SETTLED_SEC + 1 }
    );
    await save(user, {
      rkey: '3ksavedrank0002',
      url: 'https://web.example/other',
      title: 'Monetary history',
      content: `<p>${'Background on central banking. '.repeat(200)} Keynes wrote on liquidity.</p>`,
    });
    // Highlighted too, so the two differ only in what matched.
    await addLabel(
      user,
      `at://${user.did}/app.skyreader.feed.saved/3ksavedrank0002`,
      'highlights',
      {
        highlights: [{ id: 'h', selector: { exact: 'Background' }, createdAt: SETTLED_SEC * 1000 }],
      },
      { updatedAt: SETTLED_SEC + 1 }
    );
    // Enough other items that bm25's term weights mean something.
    for (let n = 0; n < 8; n++) {
      await save(user, {
        rkey: `3ksavedfill000${n}`,
        url: `https://web.example/fill-${n}`,
        title: `Unrelated ${n}`,
        content: '<p>Gardening notes.</p>',
      });
    }
    const body = await search(user, 'keynes liquidity');
    expect(body.results.map((r) => r.title)).toEqual([
      'Keynes and the general theory',
      'Monetary history',
    ]);
  });

  it('defers saves past the per-build text budget, and the sync drains them', async () => {
    const user = await createUser();
    const book = (n: number) =>
      `<p>Opening ${n} mentions halibut.</p><p>${'long book body text '.repeat(45_000)}</p>`; // ~900k
    for (let n = 0; n < 6; n++) {
      await save(user, {
        rkey: `3kbudgetbook00${n}`,
        url: `https://books.example/${n}.epub`,
        title: `Book ${n}`,
        content: book(n),
        contentType: 'epub',
      });
    }
    const keys = Array.from(
      { length: 6 },
      (_, n) => `at://${user.did}/app.skyreader.feed.saved/3kbudgetbook00${n}`
    );
    const built = await buildIndexDocs(env, user.did, keys);
    expect(built.upserts.length).toBeGreaterThan(0);
    expect(built.deferred.length).toBeGreaterThan(0);
    expect([...built.upserts.map((d) => d.key), ...built.deferred].sort()).toEqual(keys.sort());

    const stub = searchIndexStub(env, user.did);
    await stub.nudge(user.did);
    for (let i = 0; i < 10 && (await runDurableObjectAlarm(stub)); i++) {
      // drain
    }
    expect((await stub.stats()).indexedItems).toBe(6);
    const body = await search(user, 'halibut');
    expect(body.total).toBe(6);
    expect(body.index.building).toBe(false);
  });

  it('matches terms split between the text and the notes, and keeps notes current', async () => {
    const user = await createUser();
    await save(user, {
      rkey: '3ksavednotes001',
      url: 'https://web.example/glaciers',
      title: 'Glaciers retreating',
      content: '<p>Meltwater carves the valley.</p>',
    });
    const key = `at://${user.did}/app.skyreader.feed.saved/3ksavednotes001`;
    await addLabel(
      user,
      key,
      'highlights',
      {
        highlights: [
          {
            id: 'h1',
            selector: { exact: 'Meltwater' },
            note: 'compare with fjords',
            createdAt: SETTLED_SEC * 1000,
          },
        ],
      },
      { updatedAt: SETTLED_SEC + 1 }
    );

    // One term in the body, one only in the note.
    const split = await search(user, 'valley fjords');
    expect(split.results).toHaveLength(1);
    expect(split.results[0].snippet.some((s) => s.match)).toBe(true);
    expect((await search(user, 'fjords')).results[0]?.snippet).toContainEqual({
      text: 'fjords',
      match: true,
    });
    // An exclusion that only the note contains drops the item.
    expect((await search(user, 'valley -fjords')).total).toBe(0);
    expect((await search(user, 'valley -tundra')).total).toBe(1);

    // Editing the note replaces its words.
    await env.DB.prepare(
      `UPDATE item_labels_cache SET props = ?, updated_at = ? WHERE user_did = ? AND item_key = ?`
    )
      .bind(
        JSON.stringify({
          highlights: [
            {
              id: 'h1',
              selector: { exact: 'Meltwater' },
              note: 'compare with moraines',
              createdAt: SETTLED_SEC * 1000,
            },
          ],
        }),
        SETTLED_SEC + 2,
        user.did,
        key
      )
      .run();
    expect((await search(user, 'fjords')).total).toBe(0);
    expect((await search(user, 'valley moraines')).total).toBe(1);
    expect((await search(user, 'meltwater')).total).toBe(1);
    await expectIndexConsistent(user);
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

describe('GET /api/auth/me searchEnabled', () => {
  it('reports the operator switch alongside the plan flag', async () => {
    const user = await createUser();
    await setSearchSwitch('1');
    const on = (await (await call(user, '/api/auth/me')).json()) as {
      searchEnabled: boolean;
      limits: { fullTextSearch: boolean };
    };
    expect(on.searchEnabled).toBe(true);
    expect(on.limits.fullTextSearch).toBe(true);

    await setSearchSwitch('0');
    const off = (await (await call(user, '/api/auth/me')).json()) as { searchEnabled: boolean };
    expect(off.searchEnabled).toBe(false);
  });
});
