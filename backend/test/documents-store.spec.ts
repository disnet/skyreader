import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyDocumentEvent,
  authorRetryBackoffMs,
  backfillAuthorDocuments,
  chargeQueries,
  createBackfillScheduler,
  createDocumentApplyContext,
  createDocumentDrain,
  createQueryLedger,
  ensureAuthorDocuments,
  loadAuthorDocuments,
  reconcileStaleAuthors,
  serveDocumentScope,
  serveSingleDocument,
  staleDocumentAuthors,
  subscribedDocumentAuthorPage,
  subscribedDocumentAuthors,
  trimAuthorDocuments,
  AUTHOR_RETRY_BASE_MS,
  AUTHOR_RETRY_MAX_MS,
  BACKFILL_FRESHNESS_MS,
  BACKFILL_LIST_SUBREQUESTS,
  BACKFILL_QUERY_COST,
  CRON_DOCUMENT_QUERY_BUDGET,
  CRON_HOURLY_RECONCILE_AUTHORS,
  CRON_MINUTE_RECONCILE_AUTHORS,
  CYCLE_BACKFILL_QUERY_BUDGET,
  D1_QUERIES_PER_INVOCATION,
  DOCUMENT_CYCLE_QUERY_RESERVE,
  DOCUMENT_DRAIN_QUERY_BUDGET,
  MAX_COLLECTION_WRITES_PER_BACKFILL,
  MAX_CYCLE_BACKFILLS,
  MAX_SITE_RESOLVES_PER_BACKFILL,
  SCHEDULED_BACKFILL_QUERY_COST,
  SUBREQUESTS_PER_SITE_RESOLVE,
  type DocumentCommitEvent,
} from '../src/services/document-store';
import {
  digestScope,
  MAX_DOCUMENTS_PER_AUTHOR,
  MAX_LIST_PAGES,
} from '../src/services/standard-site';
import {
  readDocumentFlags,
  setDocumentFlag,
  DOCUMENTS_APPLY_CAP_KEY,
  DOCUMENTS_V2_ENABLED_KEY,
  MAX_DOCUMENT_APPLY_CAP,
} from '../src/services/document-flags';
import {
  buildDocumentSubscribeUrl,
  DID_URL_PARAM_LIMIT,
} from '../src/durable-objects/jetstream-poller';
import { handleV2BatchDocumentFetch, handleV2GetDocument } from '../src/routes/feeds-v2';
import type { Env, Session } from '../src/types';

const AUTHOR = 'did:plc:documentauthor';
const OTHER = 'did:plc:someoneelse';
const PUBLICATION = `at://${AUTHOR}/site.standard.publication/pub1`;
const OTHER_PUBLICATION = `at://${AUTHOR}/site.standard.publication/pub2`;
const READER = 'did:plc:documentreader';

const SESSION = { did: READER } as Session;

function docEvent(
  rkey: string,
  overrides: {
    did?: string;
    operation?: 'create' | 'update' | 'delete';
    cid?: string;
    site?: string;
    title?: string;
    publishedAt?: string;
    path?: string;
    time_us?: number;
  } = {}
): DocumentCommitEvent & { kind: 'commit'; time_us?: number } {
  const { operation = 'create', did = AUTHOR, cid = `cid-${rkey}` } = overrides;
  return {
    did,
    kind: 'commit',
    time_us: overrides.time_us,
    commit: {
      operation,
      collection: 'site.standard.document',
      rkey,
      cid,
      record:
        operation === 'delete'
          ? undefined
          : {
              $type: 'site.standard.document',
              site: overrides.site ?? PUBLICATION,
              title: overrides.title ?? `Post ${rkey}`,
              path: overrides.path ?? `/${rkey}`,
              publishedAt: overrides.publishedAt ?? '2026-01-01T00:00:00.000Z',
            },
    },
  };
}

async function seedPublication(uri = PUBLICATION, baseUrl = 'https://ex.com'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO publications_cache_v2 (publication_uri, base_url, icon, name, theme, fonts, cached_at)
     VALUES (?, ?, NULL, ?, NULL, NULL, ?)
     ON CONFLICT(publication_uri) DO UPDATE SET base_url = excluded.base_url, cached_at = excluded.cached_at`
  )
    .bind(uri, baseUrl, 'Ex', Date.now())
    .run();
}

/** `subscriptions_cache` is keyed to a real user row. */
async function seedReader(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url) VALUES (?, ?, 'https://pds.example')
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(READER, 'reader.test')
    .run();
}

async function cleanup(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM documents_v2'),
    env.DB.prepare('DELETE FROM collections_v2'),
    env.DB.prepare('DELETE FROM document_authors'),
    env.DB.prepare('DELETE FROM publications_cache_v2'),
    env.DB.prepare('DELETE FROM subscriptions_cache'),
    env.DB.prepare("DELETE FROM sync_state WHERE key LIKE 'documents%'"),
  ]);
}

describe('document event apply', () => {
  const allowed = new Set([AUTHOR]);

  beforeEach(async () => {
    await cleanup();
    await seedPublication();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it('creates, edits in place, and deletes', async () => {
    expect(await applyDocumentEvent(env, docEvent('a'), allowed)).toBe(true);
    let docs = await loadAuthorDocuments(env, AUTHOR);
    expect(docs.map((d) => d.title)).toEqual(['Post a']);
    expect(docs[0].canonicalUrl).toBe('https://ex.com/a');

    // An edit to the same rkey replaces the row rather than adding one — the cid
    // change is what moves the scope digest.
    expect(
      await applyDocumentEvent(
        env,
        docEvent('a', { operation: 'update', cid: 'cid-a2', title: 'Edited' }),
        allowed
      )
    ).toBe(true);
    docs = await loadAuthorDocuments(env, AUTHOR);
    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('Edited');
    expect(docs[0].recordCid).toBe('cid-a2');

    expect(await applyDocumentEvent(env, docEvent('a', { operation: 'delete' }), allowed)).toBe(
      true
    );
    expect(await loadAuthorDocuments(env, AUTHOR)).toEqual([]);
  });

  // Layer 2 of the spike defence: even if the server-side DID filter is absent,
  // broken, or briefly not yet applied (the options_update window), a foreign
  // author's event is a no-op, never a wrong row.
  it('ignores an author nobody subscribes to', async () => {
    expect(await applyDocumentEvent(env, docEvent('x', { did: OTHER }), allowed)).toBe(false);
    expect(await loadAuthorDocuments(env, OTHER)).toEqual([]);
  });

  it('ignores collections outside the document pair', async () => {
    const event = docEvent('a');
    event.commit!.collection = 'app.bsky.feed.post';
    expect(await applyDocumentEvent(env, event, allowed)).toBe(false);
  });

  it('stores and clears a reader-collection sidecar', async () => {
    const upsert: DocumentCommitEvent = {
      did: AUTHOR,
      commit: {
        operation: 'create',
        collection: 'app.standard-reader.collection',
        rkey: 'edition1',
        cid: 'cid-edition',
        record: { document: `at://${AUTHOR}/site.standard.document/edition1`, items: [] },
      },
    };
    expect(await applyDocumentEvent(env, upsert, allowed)).toBe(true);
    let row = await env.DB.prepare('SELECT rkey FROM collections_v2 WHERE author_did = ?')
      .bind(AUTHOR)
      .first();
    expect(row).not.toBeNull();

    expect(
      await applyDocumentEvent(
        env,
        { did: AUTHOR, commit: { ...upsert.commit!, operation: 'delete', record: undefined } },
        allowed
      )
    ).toBe(true);
    row = await env.DB.prepare('SELECT rkey FROM collections_v2 WHERE author_did = ?')
      .bind(AUTHOR)
      .first();
    expect(row).toBeNull();
  });

  // Layer 4: the flood a subscribed author can cause passes every filter by
  // design, so storage per author has to be bounded at the row level.
  it('evicts an author’s oldest documents past the per-author cap', async () => {
    const rows = [];
    for (let i = 0; i < MAX_DOCUMENTS_PER_AUTHOR + 5; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      rows.push(
        env.DB.prepare(
          `INSERT INTO documents_v2 (record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        ).bind(
          `at://${AUTHOR}/site.standard.document/doc${i}`,
          AUTHOR,
          `doc${i}`,
          `cid${i}`,
          PUBLICATION,
          Date.parse(`2026-01-${day}T00:00:00.000Z`) + i,
          JSON.stringify({ title: `Doc ${i}`, site: PUBLICATION }),
          Date.now()
        )
      );
    }
    await env.DB.batch(rows);

    const evicted = await trimAuthorDocuments(env, AUTHOR);
    expect(evicted).toBe(5);
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM documents_v2 WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ n: number }>();
    expect(count?.n).toBe(MAX_DOCUMENTS_PER_AUTHOR);
  });
});

describe('the per-cycle apply cap (spike drill)', () => {
  const allowed = new Set([AUTHOR]);

  beforeEach(async () => {
    await cleanup();
    await seedPublication();
  });

  afterEach(cleanup);

  it('applies exactly the cap, carries the cursor, and drains the rest next cycle', async () => {
    const burst = Array.from({ length: 12 }, (_, i) =>
      docEvent(`burst${i}`, { time_us: 1_000 + i })
    );

    const first = createDocumentDrain(env, { allowed, cap: 5, cursor: '900' });
    const outcomes: string[] = [];
    for (const event of burst) outcomes.push(await first.handle(event));

    expect(first.applied).toBe(5);
    expect(first.capped).toBe(true);
    expect(outcomes.filter((o) => o === 'applied').length).toBe(5);
    // The cursor sits at the fifth event, NOT at the twelfth: the seven skipped
    // events are still ahead of it, so the next cycle replays them.
    expect(first.cursor).toBe(String(1_000 + 4));

    const afterFirst = await loadAuthorDocuments(env, AUTHOR);
    expect(afterFirst.length).toBe(5);

    // Resume from the carried cursor with the events it never saw.
    const second = createDocumentDrain(env, { allowed, cap: 100, cursor: first.cursor });
    for (const event of burst.slice(5)) await second.handle(event);
    expect(second.capped).toBe(false);
    expect(second.applied).toBe(7);
    expect(second.cursor).toBe(String(1_000 + 11));

    const all = await loadAuthorDocuments(env, AUTHOR);
    expect(all.length).toBe(12);
  });

  it('keeps same-rkey edits in order and counts an edit as one applied event', async () => {
    const drain = createDocumentDrain(env, { allowed, cap: 10, cursor: '1' });
    await drain.handle(docEvent('same', { time_us: 10, title: 'First' }));
    await drain.handle(
      docEvent('same', { operation: 'update', cid: 'cid-2', title: 'Second', time_us: 20 })
    );
    const docs = await loadAuthorDocuments(env, AUTHOR);
    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('Second');
    expect(drain.applied).toBe(2);
    expect(drain.cursor).toBe('20');
  });

  it('does not advance the cursor past an event it refused on the cap', async () => {
    const drain = createDocumentDrain(env, { allowed, cap: 1, cursor: '5' });
    await drain.handle(docEvent('one', { time_us: 100 }));
    const outcome = await drain.handle(docEvent('two', { time_us: 200 }));
    expect(outcome).toBe('capped');
    expect(drain.cursor).toBe('100');
  });

  it('skips a non-document collection without spending cap budget', async () => {
    const drain = createDocumentDrain(env, { allowed, cap: 1, cursor: '5' });
    const event = docEvent('post', { time_us: 50 });
    event.commit!.collection = 'app.bsky.feed.post';
    expect(await drain.handle(event)).toBe('skipped');
    expect(drain.applied).toBe(0);
    expect(drain.capped).toBe(false);
  });

  // D1 refuses every query past its per-invocation ceiling, and the drain would
  // meet that ceiling the worst possible way: a throw per event, counted as an
  // error, cursor walked past the burst. So the budget stops the cycle first, with
  // the same cursor-carry the apply cap gets.
  it('stops on the query budget before D1 would refuse the write', async () => {
    const burst = Array.from({ length: 20 }, (_, i) => docEvent(`b${i}`, { time_us: 2_000 + i }));
    // Room for a handful of events plus the flush they earn, far below `cap`.
    const drain = createDocumentDrain(env, {
      allowed,
      cap: 1_000,
      cursor: '1_000',
      queryBudget: 20,
    });
    for (const event of burst) await drain.handle(event);

    expect(drain.capped).toBe(true);
    expect(drain.cappedBy).toBe('query-budget');
    expect(drain.applied).toBeGreaterThan(0);
    expect(drain.applied).toBeLessThan(burst.length);
    expect(drain.errors).toBe(0);
    // The cursor sits at the last event it applied, so the rest replay next cycle.
    expect(drain.cursor).toBe(String(2_000 + drain.applied - 1));

    await drain.flush();
    // Nothing was lost: what it refused, the next cycle applies.
    const second = createDocumentDrain(env, { allowed, cap: 1_000, cursor: drain.cursor });
    for (const event of burst.slice(drain.applied)) await second.handle(event);
    await second.flush();
    expect(second.capped).toBe(false);
    expect((await loadAuthorDocuments(env, AUTHOR)).length).toBe(burst.length);
  });

  // One statement per applied event is what makes the budget above affordable: the
  // cap eviction and the bookkeeping ride the flush, once per author.
  it('spends one query per applied event and evicts past the cap at the flush', async () => {
    const burst = Array.from({ length: 8 }, (_, i) => docEvent(`q${i}`, { time_us: 3_000 + i }));
    const drain = createDocumentDrain(env, { allowed, cap: 100, cursor: '2_999' });
    for (const event of burst) await drain.handle(event);

    // Eight writes plus the one publication resolve they share — charged whole, at
    // five subrequests, because its three cross-PDS fetches come out of the same
    // per-invocation ceiling as its two D1 statements.
    expect(drain.queries).toBe(burst.length + 5);
    // Bookkeeping is deferred with the trim, so nothing has stamped the author yet.
    const before = await env.DB.prepare(
      'SELECT last_event_at FROM document_authors WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ last_event_at: number | null }>();
    expect(before).toBeNull();

    await drain.flush();
    const after = await env.DB.prepare(
      'SELECT last_event_at FROM document_authors WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ last_event_at: number | null }>();
    expect(after?.last_event_at).toBeTruthy();
    // Two statements for the one author written, whatever the event count.
    expect(drain.queries).toBe(burst.length + 7);
  });

  // `last_event_at` is meant to read as "the last event we applied for this
  // author". A cycle that only deletes applies events too, and used to leave the
  // author unstamped because only the upsert path marked them.
  it('stamps an author whose cycle only deleted', async () => {
    await applyDocumentEvent(env, docEvent('gone'), allowed);
    await env.DB.prepare('UPDATE document_authors SET last_event_at = NULL WHERE author_did = ?')
      .bind(AUTHOR)
      .run();

    const drain = createDocumentDrain(env, { allowed, cap: 10, cursor: '5_000' });
    expect(await drain.handle(docEvent('gone', { operation: 'delete', time_us: 5_001 }))).toBe(
      'applied'
    );
    await drain.flush();

    const row = await env.DB.prepare(
      'SELECT last_event_at FROM document_authors WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ last_event_at: number | null }>();
    expect(row?.last_event_at).toBeTruthy();
    expect((await loadAuthorDocuments(env, AUTHOR)).length).toBe(0);
  });

  // The per-author row cap is layer 4 of the spike guard. It now lands at the
  // flush rather than on every write, so the drill is: burst past the cap in one
  // cycle, and check the cycle still ends under it.
  it('holds the per-author row cap across a burst that overshoots it', async () => {
    const overshoot = 5;
    const burst = Array.from({ length: MAX_DOCUMENTS_PER_AUTHOR + overshoot }, (_, i) =>
      docEvent(`cap${String(i).padStart(3, '0')}`, {
        time_us: 4_000 + i,
        publishedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      })
    );
    const drain = createDocumentDrain(env, { allowed, cap: burst.length, cursor: '3_999' });
    for (const event of burst) await drain.handle(event);
    await drain.flush();

    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM documents_v2 WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ n: number }>();
    expect(count?.n).toBe(MAX_DOCUMENTS_PER_AUTHOR);
    // The oldest are the ones evicted, exactly as the per-event trim did.
    const oldest = await env.DB.prepare(
      'SELECT rkey FROM documents_v2 WHERE author_did = ? ORDER BY published_at ASC LIMIT 1'
    )
      .bind(AUTHOR)
      .first<{ rkey: string }>();
    expect(oldest?.rkey).toBe(`cap${String(overshoot).padStart(3, '0')}`);
  });
});

describe('the connect-time DID filter', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('sends a small author set as wantedDids URL params', () => {
    const { url, viaFrame } = buildDocumentSubscribeUrl([AUTHOR, OTHER], '1234');
    const parsed = new URL(url);
    expect(viaFrame).toBe(false);
    expect(parsed.searchParams.getAll('wantedCollections')).toEqual([
      'site.standard.document',
      'app.standard-reader.collection',
    ]);
    expect(parsed.searchParams.getAll('wantedDids')).toEqual([AUTHOR, OTHER]);
    expect(parsed.searchParams.get('cursor')).toBe('1234');
  });

  it('switches to an options_update frame past the URL limit', () => {
    const many = Array.from({ length: DID_URL_PARAM_LIMIT + 1 }, (_, i) => `did:plc:author${i}`);
    const { url, viaFrame } = buildDocumentSubscribeUrl(many);
    expect(viaFrame).toBe(true);
    expect(new URL(url).searchParams.getAll('wantedDids')).toEqual([]);
  });

  // A junk row in D1 would be rejected by Jetstream *wholesale*, closing the socket
  // and silently killing the cycle's drain — so it must never reach the filter.
  it('excludes malformed DIDs from the subscribed-author set', async () => {
    await seedReader();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
         VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
      ).bind(READER, 'at://reader/app.skyreader.feed.subscription/1', PUBLICATION, AUTHOR),
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
         VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
      ).bind(READER, 'at://reader/app.skyreader.feed.subscription/2', OTHER_PUBLICATION, 'did:'),
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, created_at)
         VALUES (?, ?, ?, unixepoch())`
      ).bind(READER, 'at://reader/app.skyreader.feed.subscription/3', 'https://rss.example/feed'),
    ]);

    expect(await subscribedDocumentAuthors(env)).toEqual([AUTHOR]);
  });
});

describe('backfill and reconcile', () => {
  beforeEach(async () => {
    await cleanup();
    await seedPublication();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  function mockPds(
    records: Array<{ rkey: string; cid: string; title: string }>,
    collections: { rkeys?: string[]; fails?: boolean } = {}
  ): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('listRecords') && url.includes('app.standard-reader.collection')) {
        if (collections.fails) return new Response('nope', { status: 503 });
        return new Response(
          JSON.stringify({
            records: (collections.rkeys ?? []).map((rkey) => ({
              uri: `at://${AUTHOR}/app.standard-reader.collection/${rkey}`,
              value: { document: `at://${AUTHOR}/site.standard.document/${rkey}`, items: [] },
            })),
          })
        );
      }
      if (url.includes('plc.directory')) {
        return new Response(
          JSON.stringify({
            id: AUTHOR,
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://pds.example',
              },
            ],
          })
        );
      }
      if (url.includes('listRecords') && url.includes('site.standard.document')) {
        return new Response(
          JSON.stringify({
            records: records.map((r) => ({
              uri: `at://${AUTHOR}/site.standard.document/${r.rkey}`,
              cid: r.cid,
              value: {
                site: PUBLICATION,
                title: r.title,
                path: `/${r.rkey}`,
                publishedAt: '2026-01-01T00:00:00.000Z',
              },
            })),
          })
        );
      }
      if (url.includes('listRecords')) return new Response(JSON.stringify({ records: [] }));
      return new Response('{}', { status: 404 });
    });
  }

  it('is idempotent and prunes what the repo no longer has', async () => {
    mockPds([
      { rkey: 'one', cid: 'cid1', title: 'One' },
      { rkey: 'two', cid: 'cid2', title: 'Two' },
    ]);

    const first = await backfillAuthorDocuments(env, AUTHOR);
    expect(first.ok).toBe(true);
    expect(first.documents).toBe(2);
    expect(first.complete).toBe(true);

    const second = await backfillAuthorDocuments(env, AUTHOR);
    expect(second.documents).toBe(2);
    const docs = await loadAuthorDocuments(env, AUTHOR);
    expect(docs.length).toBe(2);

    // A record deleted upstream while we weren't watching is the drift the
    // firehose alone can never correct.
    mockPds([{ rkey: 'one', cid: 'cid1', title: 'One' }]);
    await backfillAuthorDocuments(env, AUTHOR);
    expect((await loadAuthorDocuments(env, AUTHOR)).map((d) => d.title)).toEqual(['One']);
  });

  it('records the error and leaves the stored set alone when the PDS fails', async () => {
    mockPds([{ rkey: 'one', cid: 'cid1', title: 'One' }]);
    await backfillAuthorDocuments(env, AUTHOR);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const failed = await backfillAuthorDocuments(env, AUTHOR);
    expect(failed.ok).toBe(false);
    // The reader keeps seeing what we already hold.
    expect((await loadAuthorDocuments(env, AUTHOR)).length).toBe(1);
    const author = await env.DB.prepare(
      'SELECT error_count FROM document_authors WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ error_count: number }>();
    expect(author?.error_count).toBe(1);
  });

  it('prunes a curated edition the author deleted', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO collections_v2 (author_did, rkey, record_json, indexed_at) VALUES (?, 'keep', '{}', ?)`
      ).bind(AUTHOR, Date.now()),
      env.DB.prepare(
        `INSERT INTO collections_v2 (author_did, rkey, record_json, indexed_at) VALUES (?, 'gone', '{}', ?)`
      ).bind(AUTHOR, Date.now()),
    ]);

    mockPds([{ rkey: 'one', cid: 'cid1', title: 'One' }], { rkeys: ['keep'] });
    await backfillAuthorDocuments(env, AUTHOR);

    const rows = await env.DB.prepare(
      'SELECT rkey FROM collections_v2 WHERE author_did = ? ORDER BY rkey'
    )
      .bind(AUTHOR)
      .all<{ rkey: string }>();
    expect(rows.results?.map((r) => r.rkey)).toEqual(['keep']);
  });

  // An empty map from a failed fetch and an empty map from an author with no
  // editions look identical; pruning against the first would delete every curated
  // edition we hold on one blip.
  it('leaves stored editions alone when the collection listing fails', async () => {
    await env.DB.prepare(
      `INSERT INTO collections_v2 (author_did, rkey, record_json, indexed_at) VALUES (?, 'keep', '{}', ?)`
    )
      .bind(AUTHOR, Date.now())
      .run();

    mockPds([{ rkey: 'one', cid: 'cid1', title: 'One' }], { fails: true });
    const result = await backfillAuthorDocuments(env, AUTHOR);
    expect(result.ok).toBe(true);

    const row = await env.DB.prepare('SELECT rkey FROM collections_v2 WHERE author_did = ?')
      .bind(AUTHOR)
      .first();
    expect(row).not.toBeNull();
  });

  it('picks never-listed subscribed authors first and re-lists them', async () => {
    await seedReader();
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
       VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
    )
      .bind(READER, 'at://reader/app.skyreader.feed.subscription/1', PUBLICATION, AUTHOR)
      .run();

    expect(await staleDocumentAuthors(env, 5)).toEqual([AUTHOR]);

    mockPds([{ rkey: 'one', cid: 'cid1', title: 'One' }]);
    const results = await reconcileStaleAuthors(env, 5);
    expect(results.map((r) => r.ok)).toEqual([true]);
    // Freshly listed: it drops out of the stale set until the reconcile interval.
    expect(await staleDocumentAuthors(env, 5)).toEqual([]);
  });

  // The reconcile is the only self-heal in this design. An author who can never be
  // listed — deleted account, dead PDS — used to sort first on every run forever
  // (their `last_listed_at` stays NULL), so a handful of them starved it silently.
  it('yields the reconcile slot after a failed list instead of monopolising it', async () => {
    await seedReader();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
         VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
      ).bind(READER, 'at://reader/app.skyreader.feed.subscription/1', PUBLICATION, AUTHOR),
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
         VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
      ).bind(READER, 'at://reader/app.skyreader.feed.subscription/2', OTHER_PUBLICATION, OTHER),
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }));
    expect((await backfillAuthorDocuments(env, AUTHOR)).ok).toBe(false);

    // Inside its backoff the dead author is out of the queue, so the other one —
    // which the old ordering could never reach — gets the slot.
    expect(await staleDocumentAuthors(env, 5)).toEqual([OTHER]);

    // Held off, not abandoned: it is retried once the backoff expires.
    const later = Date.now() + authorRetryBackoffMs(1) + 1_000;
    expect(await staleDocumentAuthors(env, 5, later)).toContain(AUTHOR);
  });

  it('backs off further with each consecutive failure', () => {
    expect(authorRetryBackoffMs(1)).toBe(AUTHOR_RETRY_BASE_MS);
    expect(authorRetryBackoffMs(3)).toBe(AUTHOR_RETRY_BASE_MS * 4);
    expect(authorRetryBackoffMs(50)).toBe(AUTHOR_RETRY_MAX_MS);
  });

  // Every path that creates an atproto.documents subscription funnels through
  // this, and the same author subscribed by ten readers must cost one walk.
  it('skips a backfill for an author listed recently', async () => {
    mockPds([{ rkey: 'one', cid: 'cid1', title: 'One' }]);
    expect((await ensureAuthorDocuments(env, AUTHOR))?.ok).toBe(true);
    const callsAfterFirst = vi.mocked(globalThis.fetch).mock.calls.length;

    expect(await ensureAuthorDocuments(env, AUTHOR)).toBeNull();
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(callsAfterFirst);

    // Past the freshness window it lists again — this is also the reconcile's path.
    const later = Date.now() + BACKFILL_FRESHNESS_MS + 1_000;
    expect((await ensureAuthorDocuments(env, AUTHOR, later))?.ok).toBe(true);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('does not retry an author inside their failure backoff', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }));
    expect((await ensureAuthorDocuments(env, AUTHOR))?.ok).toBe(false);
    const calls = vi.mocked(globalThis.fetch).mock.calls.length;

    expect(await ensureAuthorDocuments(env, AUTHOR)).toBeNull();
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
  });
});

// D1 refuses everything past `D1_QUERIES_PER_INVOCATION`, and a fan-out of walks is
// the one place where crossing it mutates D1 half way and then throws. So the
// per-author cost has to be a real worst case, and the fan-out has to be admitted
// against one shared ledger rather than against a per-loop rule.
describe('the backfill query budget', () => {
  beforeEach(async () => {
    await cleanup();
    await seedPublication();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  /** A PDS with `documents` documents and `collections` curated editions. */
  function mockBigPds(documents: number, collections: number): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('plc.directory')) {
        return new Response(
          JSON.stringify({
            id: AUTHOR,
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://pds.example',
              },
            ],
          })
        );
      }
      if (url.includes('listRecords') && url.includes('app.standard-reader.collection')) {
        return new Response(
          JSON.stringify({
            records: Array.from({ length: collections }, (_, i) => ({
              uri: `at://${AUTHOR}/app.standard-reader.collection/new${String(i).padStart(3, '0')}`,
              value: { document: `at://${AUTHOR}/site.standard.document/new${i}`, items: [] },
            })),
          })
        );
      }
      if (url.includes('listRecords') && url.includes('site.standard.document')) {
        return new Response(
          JSON.stringify({
            records: Array.from({ length: documents }, (_, i) => {
              const rkey = `new${String(i).padStart(3, '0')}`;
              return {
                uri: `at://${AUTHOR}/site.standard.document/${rkey}`,
                cid: `cid-${rkey}`,
                value: {
                  site: PUBLICATION,
                  title: `New ${i}`,
                  path: `/${rkey}`,
                  publishedAt: '2026-02-01T00:00:00.000Z',
                },
              };
            }),
          })
        );
      }
      if (url.includes('listRecords')) return new Response(JSON.stringify({ records: [] }));
      return new Response('{}', { status: 404 });
    });
  }

  const DID_DOCUMENT = JSON.stringify({
    id: AUTHOR,
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://pds.example',
      },
    ],
  });

  function listedDocument(i: number) {
    const rkey = `new${String(i).padStart(3, '0')}`;
    return {
      uri: `at://${AUTHOR}/site.standard.document/${rkey}`,
      cid: `cid-${rkey}`,
      value: {
        site: PUBLICATION,
        title: `New ${i}`,
        path: `/${rkey}`,
        publishedAt: '2026-02-01T00:00:00.000Z',
      },
    };
  }

  /** What the walk actually spent on the network, by kind of request. */
  interface PdsFetchCounts {
    didDocuments: number;
    documentPages: number;
    collectionPages: number;
  }

  /**
   * A PDS that pages its document listing — a page is whatever the server chooses to
   * return, so `MAX_LIST_PAGES` fetches for one repo is a real shape, not a
   * hypothetical. Returns the per-kind counts so a test can check what the walk spent
   * rather than what it charged itself.
   */
  function mockBigPdsPaged(documents: number, collections: number, pageSize = 20): PdsFetchCounts {
    const counts: PdsFetchCounts = { didDocuments: 0, documentPages: 0, collectionPages: 0 };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'plc.directory') {
        counts.didDocuments++;
        return new Response(DID_DOCUMENT);
      }
      const collection = url.searchParams.get('collection');
      if (collection === 'app.standard-reader.collection') {
        counts.collectionPages++;
        return new Response(
          JSON.stringify({
            records: Array.from({ length: collections }, (_, i) => ({
              uri: `at://${AUTHOR}/app.standard-reader.collection/new${String(i).padStart(3, '0')}`,
              value: { document: `at://${AUTHOR}/site.standard.document/new${i}`, items: [] },
            })),
          })
        );
      }
      if (collection === 'site.standard.document') {
        counts.documentPages++;
        const page = Number(url.searchParams.get('cursor') ?? '0');
        const start = page * pageSize;
        const records = Array.from(
          { length: Math.max(0, Math.min(pageSize, documents - start)) },
          (_, i) => listedDocument(start + i)
        );
        const more = start + records.length < documents;
        return new Response(
          JSON.stringify({ records, ...(more ? { cursor: String(page + 1) } : {}) })
        );
      }
      return new Response('{}', { status: 404 });
    });
    return counts;
  }

  /** Stored rows a re-list will find nothing for — the prune-heavy shape. */
  async function seedStoredDocuments(count: number): Promise<void> {
    const stamp = Date.now() - 60_000;
    await env.DB.batch(
      Array.from({ length: count }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO documents_v2
             (record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at, updated_at)
           VALUES (?, ?, ?, 'cid-old', ?, ?, NULL, '{"site":"","title":"Old"}', ?, ?)`
        ).bind(
          `at://${AUTHOR}/site.standard.document/old${String(i).padStart(3, '0')}`,
          AUTHOR,
          `old${String(i).padStart(3, '0')}`,
          PUBLICATION,
          stamp,
          stamp,
          stamp
        )
      )
    );
  }

  // The shape the old constant (`MAX_DOCUMENTS_PER_AUTHOR + 12`) was three times
  // short on: a full stored set that shares nothing with the listing, so the prune
  // is as large as the write loop, plus a sidecar page to go with it.
  it('stays under the per-author cost on a prune-heavy author', async () => {
    await seedStoredDocuments(MAX_DOCUMENTS_PER_AUTHOR);
    mockBigPds(MAX_DOCUMENTS_PER_AUTHOR, 100);

    const ctx = createDocumentApplyContext(createQueryLedger());
    const result = await backfillAuthorDocuments(env, AUTHOR, ctx);

    expect(result.ok).toBe(true);
    expect(ctx.ledger.spent).toBeLessThanOrEqual(BACKFILL_QUERY_COST);
    // The whole stored set was replaced, in one statement rather than a hundred.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM documents_v2 WHERE author_did = ? AND rkey LIKE 'old%'"
    )
      .bind(AUTHOR)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect((await loadAuthorDocuments(env, AUTHOR)).length).toBe(MAX_DOCUMENTS_PER_AUTHOR);
  });

  /** Sidecars stored for the author. */
  async function storedCollections(): Promise<number> {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM collections_v2 WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // A small author leaves most of the document term unspent, and the sidecars get
  // it: the flat 20 was the worst case's share, not every walk's.
  it('spends its unused headroom on sidecars rather than a flat cap', async () => {
    const editions = MAX_COLLECTION_WRITES_PER_BACKFILL + 10;
    mockBigPds(1, editions);

    const result = await backfillAuthorDocuments(env, AUTHOR);

    expect(result.ok).toBe(true);
    expect(await storedCollections()).toBe(editions);
    const author = await env.DB.prepare(
      'SELECT collections_pending FROM document_authors WHERE author_did = ?'
    )
      .bind(AUTHOR)
      .first<{ collections_pending: number }>();
    expect(author?.collections_pending).toBe(0);
  });

  // The author who does hit the cap — a full repo of curated editions, which is the
  // magazine back catalogue a subscribe-time walk exists to pull. Each walk writes
  // what it can afford; the remainder stays in the reconcile queue instead of
  // waiting a full interval, so the whole set lands over the next passes.
  it('defers the sidecars it cannot afford and requeues the author for them', async () => {
    const editions = 90;
    mockBigPdsPaged(MAX_DOCUMENTS_PER_AUTHOR, editions);
    await seedReader();
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
       VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
    )
      .bind(READER, 'at://reader/app.skyreader.feed.subscription/1', PUBLICATION, AUTHOR)
      .run();

    const ctx = createDocumentApplyContext(createQueryLedger());
    await backfillAuthorDocuments(env, AUTHOR, ctx);

    const first = await storedCollections();
    expect(first).toBeGreaterThanOrEqual(MAX_COLLECTION_WRITES_PER_BACKFILL);
    expect(first).toBeLessThan(editions);
    expect(ctx.ledger.spent).toBeLessThanOrEqual(BACKFILL_QUERY_COST);

    // Freshly listed, so the interval alone would park them for a week — the
    // pending sidecars are what keeps them eligible, and they are still eligible
    // only because the walk made progress.
    expect(await staleDocumentAuthors(env, 5)).toEqual([AUTHOR]);

    // Each further pass advances by at least as much again, and stops requeueing
    // once nothing is left over.
    for (let pass = 0; pass < 3 && (await staleDocumentAuthors(env, 5)).length > 0; pass++) {
      await backfillAuthorDocuments(env, AUTHOR);
    }
    expect(await storedCollections()).toBe(editions);
    expect(await staleDocumentAuthors(env, 5)).toEqual([]);
  });

  // The fan-out bound the reviewer's scenario broke: five authors sized against a
  // per-author constant that did not hold. Now the loop asks the ledger before each
  // one and leaves the rest in the queue, where they still sort to the front.
  it('stops the reconcile at the author the invocation can no longer afford', async () => {
    await seedReader();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
         VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
      ).bind(READER, 'at://reader/app.skyreader.feed.subscription/1', PUBLICATION, AUTHOR),
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
         VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
      ).bind(READER, 'at://reader/app.skyreader.feed.subscription/2', OTHER_PUBLICATION, OTHER),
    ]);
    mockBigPds(2, 0);

    // Room for exactly one worst-case walk (plus the queue query it charges first).
    const ctx = createDocumentApplyContext(createQueryLedger(BACKFILL_QUERY_COST + 1));
    const results = await reconcileStaleAuthors(env, 5, ctx);

    expect(results.length).toBe(1);
    expect(ctx.ledger.spent).toBeLessThanOrEqual(ctx.ledger.limit);
    // Nothing was recorded against the author it skipped, so they are still at the
    // front of the queue rather than in a retry backoff.
    expect(await staleDocumentAuthors(env, 5)).toHaveLength(1);
  });

  /**
   * A PDS whose authors publish to whatever publications the test names, none of
   * them cached — so every one of them costs a resolve out of the walk's allowance.
   */
  function mockPdsWithPublications(sites: Record<string, string[]>): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'plc.directory') {
        return new Response(
          JSON.stringify({
            id: url.pathname.slice(1),
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://pds.example',
              },
            ],
          })
        );
      }
      const collection = url.searchParams.get('collection');
      const repo = url.searchParams.get('repo') ?? '';
      if (url.pathname.endsWith('getRecord') && collection === 'site.standard.publication') {
        const rkey = url.searchParams.get('rkey');
        return new Response(JSON.stringify({ value: { url: `https://${rkey}.example` } }));
      }
      if (url.pathname.endsWith('listRecords') && collection === 'site.standard.document') {
        return new Response(
          JSON.stringify({
            records: (sites[repo] ?? []).map((site, i) => ({
              uri: `at://${repo}/site.standard.document/doc${i}`,
              cid: `cid-doc${i}`,
              value: { site, title: `Doc ${i}`, path: `/doc${i}` },
            })),
          })
        );
      }
      if (url.pathname.endsWith('listRecords'))
        return new Response(JSON.stringify({ records: [] }));
      return new Response('{}', { status: 404 });
    });
  }

  async function canonicalUrlOf(authorDid: string, rkey: string): Promise<string | null> {
    const row = await env.DB.prepare(
      'SELECT canonical_url FROM documents_v2 WHERE author_did = ? AND rkey = ?'
    )
      .bind(authorDid, rkey)
      .first<{ canonical_url: string | null }>();
    return row?.canonical_url ?? null;
  }

  // A loose `https://` site is its own base URL — no cache row, no PDS record. It
  // used to be charged a full resolve anyway, so five of them starved the walk's
  // allowance on requests it never made.
  it('does not spend its resolve allowance on loose https sites', async () => {
    const loose = Array.from(
      { length: MAX_SITE_RESOLVES_PER_BACKFILL + 1 },
      (_, i) => `https://loose${i}.example`
    );
    mockPdsWithPublications({
      [AUTHOR]: [...loose, `at://${AUTHOR}/site.standard.publication/pub9`],
    });

    await backfillAuthorDocuments(env, AUTHOR);

    // The one document that actually needed a resolve still got one.
    expect(await canonicalUrlOf(AUTHOR, `doc${loose.length}`)).toBe(
      `https://pub9.example/doc${loose.length}`
    );
  });

  // The allowance is per author but the context is shared by a fan-out. A
  // publication starved during one author's walk must not stay starved for the next.
  it('gives each author in a fan-out a fresh allowance for the same publication', async () => {
    const pubs = Array.from(
      { length: MAX_SITE_RESOLVES_PER_BACKFILL + 1 },
      (_, i) => `at://${AUTHOR}/site.standard.publication/pub${i}`
    );
    const starved = pubs[pubs.length - 1];
    mockPdsWithPublications({ [AUTHOR]: pubs, [OTHER]: [starved] });

    const ctx = createDocumentApplyContext(createQueryLedger());
    await backfillAuthorDocuments(env, AUTHOR, ctx);
    // The last publication is past the first author's allowance: path only.
    expect(await canonicalUrlOf(AUTHOR, `doc${pubs.length - 1}`)).toBe(`/doc${pubs.length - 1}`);

    await backfillAuthorDocuments(env, OTHER, ctx);
    expect(await canonicalUrlOf(OTHER, 'doc0')).toBe(
      `https://pub${MAX_SITE_RESOLVES_PER_BACKFILL}.example/doc0`
    );
  });

  // The listing term, counted against the network rather than against itself. A
  // walk needs the author's PDS twice — once per listing — and `resolvePdsUrl` is an
  // uncached plc.directory fetch, so without the shared memo this is 8 spent against
  // 7 charged and the whole per-author bound is off by one.
  it('resolves the author once for both of its listings', async () => {
    const counts = mockBigPdsPaged(MAX_DOCUMENTS_PER_AUTHOR, 10);

    const ctx = createDocumentApplyContext(createQueryLedger());
    const result = await backfillAuthorDocuments(env, AUTHOR, ctx);

    expect(result.ok).toBe(true);
    expect(counts.didDocuments).toBe(1);
    expect(counts.documentPages).toBe(MAX_LIST_PAGES);
    expect(counts.collectionPages).toBe(1);
    expect(counts.didDocuments + counts.documentPages + counts.collectionPages).toBe(
      BACKFILL_LIST_SUBREQUESTS
    );
    expect(ctx.ledger.spent).toBeLessThanOrEqual(BACKFILL_QUERY_COST);
  });

  // The arithmetic each fan-out is sized by, pinned: a constant edited without its
  // budget is exactly how "five authors is well under" became untrue.
  it('sizes every fan-out budget to the worst case it admits', () => {
    // The poll cycle: what the drain reserves must actually cover its walks.
    expect(CYCLE_BACKFILL_QUERY_BUDGET).toBeGreaterThanOrEqual(
      MAX_CYCLE_BACKFILLS * SCHEDULED_BACKFILL_QUERY_COST
    );
    expect(DOCUMENT_CYCLE_QUERY_RESERVE).toBeGreaterThanOrEqual(CYCLE_BACKFILL_QUERY_BUDGET);
    expect(DOCUMENT_DRAIN_QUERY_BUDGET + DOCUMENT_CYCLE_QUERY_RESERVE).toBe(
      D1_QUERIES_PER_INVOCATION
    );

    // The hourly cron runs both reconcile passes in one invocation.
    expect(CRON_DOCUMENT_QUERY_BUDGET).toBeGreaterThanOrEqual(
      (CRON_MINUTE_RECONCILE_AUTHORS + CRON_HOURLY_RECONCILE_AUTHORS) * BACKFILL_QUERY_COST
    );
    expect(CRON_DOCUMENT_QUERY_BUDGET).toBeLessThan(D1_QUERIES_PER_INVOCATION);

    // An apply-cap override can never claim more events than the cycle can fund.
    expect(MAX_DOCUMENT_APPLY_CAP).toBe(DOCUMENT_DRAIN_QUERY_BUDGET);

    // The sidecar allowance is derived from what a walk has left, so the flat
    // constant has to be exactly what that arithmetic leaves at every other cap at
    // once — the listing, a full repo of documents, every resolve, the prune, the
    // sidecar read and the bookkeeping. Raise a term without this and the "floor"
    // silently becomes a walk that overspends its own reservation.
    const worstCaseBeforeSidecars =
      BACKFILL_LIST_SUBREQUESTS +
      MAX_DOCUMENTS_PER_AUTHOR +
      MAX_SITE_RESOLVES_PER_BACKFILL * SUBREQUESTS_PER_SITE_RESOLVE +
      // the prune, the sidecar read
      2;
    expect(BACKFILL_QUERY_COST - worstCaseBeforeSidecars - 1).toBe(
      MAX_COLLECTION_WRITES_PER_BACKFILL
    );
  });

  // The sync paths schedule their walks into the same invocation that just ran the
  // pull. A restore big enough to spend the budget schedules none of them.
  it('schedules no walks once the request has spent its budget', async () => {
    const ledger = createQueryLedger(BACKFILL_QUERY_COST * 2);
    const scheduled: Array<Promise<unknown>> = [];
    const schedule = createBackfillScheduler(env, (p) => scheduled.push(p), { ledger });

    chargeQueries(ledger, 900);
    expect(schedule(AUTHOR)).toBe(false);
    expect(scheduled.length).toBe(0);
  });

  it('reserves the whole worst case for every walk it has already scheduled', async () => {
    mockBigPds(1, 0);
    const ledger = createQueryLedger(SCHEDULED_BACKFILL_QUERY_COST * 2);
    const scheduled: Array<Promise<unknown>> = [];
    const schedule = createBackfillScheduler(env, (p) => scheduled.push(p), {
      ledger,
      limit: 5,
    });

    // Two fit; the third would only fit if the first two were assumed free.
    expect(schedule(AUTHOR)).toBe(true);
    expect(schedule(OTHER)).toBe(true);
    expect(schedule('did:plc:athirdauthor')).toBe(false);
    await Promise.all(scheduled);
    expect(ledger.spent).toBeLessThanOrEqual(ledger.limit);
  });
});

describe('walking the subscribed-author set', () => {
  const AUTHOR_A = 'did:plc:aaaaaaaaaaaaaaaa';
  const AUTHOR_B = 'did:plc:bbbbbbbbbbbbbbbb';
  const AUTHOR_C = 'did:plc:cccccccccccccccc';

  beforeEach(async () => {
    await cleanup();
    await seedReader();
    await env.DB.batch(
      [AUTHOR_A, AUTHOR_B, AUTHOR_C].map((did, i) =>
        env.DB.prepare(
          `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
           VALUES (?, ?, ?, 'atproto.documents', ?, unixepoch())`
        ).bind(
          READER,
          `at://reader/app.skyreader.feed.subscription/${i}`,
          `at://${did}/site.standard.publication/pub`,
          did
        )
      )
    );
  });

  afterEach(cleanup);

  // The shadow-compare is the gate on the read cutover, so it has to be able to
  // reach author 26 — comparing the same first page repeatedly says nothing about
  // the rest of the set.
  it('pages the whole set and reports what is left behind each page', async () => {
    const first = await subscribedDocumentAuthorPage(env, { limit: 2 });
    expect(first.dids).toEqual([AUTHOR_A, AUTHOR_B]);
    expect(first.cursor).toBe(AUTHOR_B);
    expect(first.remaining).toBe(1);

    const second = await subscribedDocumentAuthorPage(env, { limit: 2, after: first.cursor! });
    expect(second.dids).toEqual([AUTHOR_C]);
    expect(second.cursor).toBeNull();
    expect(second.remaining).toBe(0);
  });

  it('walks past a malformed DID rather than stalling on it', async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
       VALUES (?, ?, ?, 'atproto.documents', 'did:', unixepoch())`
    )
      .bind(READER, 'at://reader/app.skyreader.feed.subscription/junk', 'at://junk/pub')
      .run();

    const first = await subscribedDocumentAuthorPage(env, { limit: 1 });
    expect(first.dids).toEqual([]); // 'did:' sorts first and is dropped…
    expect(first.cursor).toBe('did:'); // …but the cursor still moves past it.
    const second = await subscribedDocumentAuthorPage(env, { limit: 10, after: first.cursor! });
    expect(second.dids).toEqual([AUTHOR_A, AUTHOR_B, AUTHOR_C]);
  });
});

describe('serveDocumentScope', () => {
  beforeEach(async () => {
    await cleanup();
    await seedPublication();
    await seedPublication(OTHER_PUBLICATION, 'https://other.example');
  });

  afterEach(cleanup);

  async function ingest(): Promise<void> {
    const allowed = new Set([AUTHOR]);
    await applyDocumentEvent(
      env,
      docEvent('a', { publishedAt: '2026-01-01T00:00:00.000Z' }),
      allowed
    );
    await applyDocumentEvent(
      env,
      docEvent('b', { publishedAt: '2026-02-01T00:00:00.000Z' }),
      allowed
    );
    await applyDocumentEvent(
      env,
      docEvent('c', { site: OTHER_PUBLICATION, publishedAt: '2026-03-01T00:00:00.000Z' }),
      allowed
    );
    // Backfill bookkeeping is what makes an empty scope "ready and empty" rather
    // than "not ingested yet".
    await env.DB.prepare(
      `INSERT INTO document_authors (author_did, last_listed_at, complete) VALUES (?, ?, 1)
       ON CONFLICT(author_did) DO UPDATE SET last_listed_at = excluded.last_listed_at, complete = 1`
    )
      .bind(AUTHOR, Date.now())
      .run();
  }

  it('serves an author newest-first, scoped to a publication', async () => {
    await ingest();
    const entry = await serveDocumentScope(env, { did: AUTHOR }, { remaining: 0 });
    expect(entry.status).toBe('ready');
    expect(entry.complete).toBe(true);
    expect(entry.documents?.map((d) => d.title)).toEqual(['Post c', 'Post b', 'Post a']);

    const scoped = await serveDocumentScope(
      env,
      { did: AUTHOR, siteUri: PUBLICATION },
      { remaining: 0 }
    );
    expect(scoped.documents?.map((d) => d.title)).toEqual(['Post b', 'Post a']);
  });

  it('short-circuits an unchanged scope on the digest', async () => {
    await ingest();
    const first = await serveDocumentScope(env, { did: AUTHOR }, { remaining: 0 });
    expect(first.digest).toBe(await digestScope(first.documents!));

    const repeat = await serveDocumentScope(
      env,
      { did: AUTHOR, since_digest: first.digest },
      { remaining: 0 }
    );
    expect(repeat.status).toBe('unchanged');
    expect(repeat.documents).toBeUndefined();

    // An edit changes the cid, so the digest misses and the full set is re-sent.
    await applyDocumentEvent(
      env,
      docEvent('a', { operation: 'update', cid: 'cid-a-edited' }),
      new Set([AUTHOR])
    );
    const afterEdit = await serveDocumentScope(
      env,
      { did: AUTHOR, since_digest: first.digest },
      { remaining: 0 }
    );
    expect(afterEdit.status).toBe('ready');
  });

  // "Ready and empty" would tell the client to clear the scope. An author we have
  // never successfully listed is an error, so the client keeps what it holds.
  it('reports an un-ingested author as an error, not an empty ready', async () => {
    const entry = await serveDocumentScope(env, { did: AUTHOR }, { remaining: 0 });
    expect(entry.status).toBe('error');
    expect(entry.documents).toEqual([]);
  });

  it('rejects a malformed DID', async () => {
    const entry = await serveDocumentScope(env, { did: 'did:' }, { remaining: 0 });
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('Invalid DID');
  });

  // `complete` says "an absent record is deleted, not merely evicted". The flag on
  // the author row was set at the last successful list and the poller keeps writing
  // afterwards, so an author listed under the cap who has since published past it
  // would otherwise claim completeness while eviction drops their oldest.
  it('reports complete from the stored row count, not the last list alone', async () => {
    await ingest();
    expect((await serveDocumentScope(env, { did: AUTHOR }, { remaining: 0 })).complete).toBe(true);

    const filler = [];
    for (let i = 0; i < MAX_DOCUMENTS_PER_AUTHOR; i++) {
      filler.push(
        env.DB.prepare(
          `INSERT INTO documents_v2 (record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        ).bind(
          `at://${AUTHOR}/site.standard.document/fill${i}`,
          AUTHOR,
          `fill${i}`,
          `cid-fill${i}`,
          PUBLICATION,
          Date.now() - i,
          JSON.stringify({ title: `Fill ${i}`, site: PUBLICATION }),
          Date.now()
        )
      );
    }
    await env.DB.batch(filler);

    const atCap = await serveDocumentScope(env, { did: AUTHOR }, { remaining: 0 });
    expect(atCap.status).toBe('ready');
    expect(atCap.complete).toBe(false);
  });

  // The row's stored URL is the durable one. A publication `getRecord` blip writes
  // a five-minute negative cache entry; without the fallback every document of that
  // publication serves a bare relative path for the duration.
  it('falls back to the stored canonical URL while the publication will not resolve', async () => {
    await ingest();
    await env.DB.prepare(
      'UPDATE publications_cache_v2 SET base_url = NULL, cached_at = ? WHERE publication_uri = ?'
    )
      .bind(Date.now(), PUBLICATION)
      .run();

    const entry = await serveDocumentScope(
      env,
      { did: AUTHOR, siteUri: PUBLICATION },
      {
        remaining: 0,
      }
    );
    expect(entry.documents?.map((d) => d.canonicalUrl)).toEqual([
      'https://ex.com/b',
      'https://ex.com/a',
    ]);

    const single = await serveSingleDocument(env, `at://${AUTHOR}/site.standard.document/a`);
    expect(single?.canonicalUrl).toBe('https://ex.com/a');
  });
});

describe('the read rollout gate', () => {
  beforeEach(async () => {
    await cleanup();
    await seedPublication();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  function batchRequest(body: unknown): Request {
    return new Request('https://api.example/api/v2/documents/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // The cap is sized from burst shape, but it also has to fit the Worker's
  // per-invocation subrequest budget — an override typed past that would make the
  // drain fail quietly, dropping the events the cap exists to protect.
  it('clamps an apply-cap override to the subrequest budget', async () => {
    await setDocumentFlag(env, DOCUMENTS_APPLY_CAP_KEY, '5000');
    expect((await readDocumentFlags(env)).applyCap).toBe(MAX_DOCUMENT_APPLY_CAP);

    await setDocumentFlag(env, DOCUMENTS_APPLY_CAP_KEY, '120');
    expect((await readDocumentFlags(env)).applyCap).toBe(120);
  });

  it('defaults to the proxy and switches to D1 on the flag', async () => {
    expect((await readDocumentFlags(env)).serveFromD1).toBe(false);

    const allowed = new Set([AUTHOR]);
    await applyDocumentEvent(env, docEvent('a'), allowed);
    await env.DB.prepare(
      `INSERT INTO document_authors (author_did, last_listed_at, complete) VALUES (?, ?, 1)
       ON CONFLICT(author_did) DO UPDATE SET last_listed_at = excluded.last_listed_at, complete = 1`
    )
      .bind(AUTHOR, Date.now())
      .run();

    const proxyFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authors: [{ did: AUTHOR, status: 'ready', documents: [] }] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const viaProxy = await handleV2BatchDocumentFetch(
      batchRequest({ documents: [{ did: AUTHOR }] }),
      env as Env,
      SESSION
    );
    expect(proxyFetch).toHaveBeenCalled();
    expect(((await viaProxy.json()) as { authors: unknown[] }).authors.length).toBe(1);

    proxyFetch.mockClear();
    await setDocumentFlag(env, DOCUMENTS_V2_ENABLED_KEY, '1');

    const viaD1 = await handleV2BatchDocumentFetch(
      batchRequest({ documents: [{ did: AUTHOR }] }),
      env as Env,
      SESSION
    );
    const body = (await viaD1.json()) as {
      authors: Array<{ status: string; documents?: Array<{ title: string; read?: boolean }> }>;
    };
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(body.authors[0].status).toBe('ready');
    expect(body.authors[0].documents?.map((d) => d.title)).toEqual(['Post a']);
    // The per-user read annotation is applied to the D1 path exactly as before.
    expect(body.authors[0].documents?.[0].read).toBe(false);
  });

  it('serves a single document from D1 when the gate is on', async () => {
    await applyDocumentEvent(env, docEvent('single'), new Set([AUTHOR]));
    await setDocumentFlag(env, DOCUMENTS_V2_ENABLED_KEY, '1');
    const uri = `at://${AUTHOR}/site.standard.document/single`;

    expect((await serveSingleDocument(env, uri))?.title).toBe('Post single');

    const res = await handleV2GetDocument(
      new Request(`https://api.example/api/v2/documents/get?uri=${encodeURIComponent(uri)}`),
      env as Env,
      SESSION
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: { title: string; read: boolean } };
    expect(body.document.title).toBe('Post single');
    expect(body.document.read).toBe(false);
  });
});
