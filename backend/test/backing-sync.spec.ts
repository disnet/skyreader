import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listBackedSaved,
  pollBackedMembership,
  backedUnsave,
  extractMissingBackedContent,
} from '../src/services/backing/sync';
import type { SaveBacking } from '../src/routes/settings';
import type { Session } from '../src/types';
import * as read from '../src/services/backing/read';
import * as write from '../src/services/backing/write';
import { FeedProxyClient } from '../src/services/feed-proxy-client';

const DID = 'did:plc:backingtest';
const COLLECTION = 'at://did:plc:backingtest/network.cosmik.collection/col1';
const BACKING: Extract<SaveBacking, { provider: 'semble' | 'margin' }> = {
  provider: 'semble',
  collectionUri: COLLECTION,
};

async function reset() {
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM backed_collection_members WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM backed_unsave_tombstones WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  // A backed user always has a user_settings row (backing is stored there) — the
  // poll's last_backing_poll stamp updates it. user_settings FKs to users.
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, last_synced_at) VALUES (?, 'backing.test', 'https://pds.test', 0)
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(`INSERT INTO user_settings (user_did, backing) VALUES (?, ?)`)
    .bind(DID, `semble:${COLLECTION}`)
    .run();
}

function member(url: string, i: number): read.BackedMember {
  return {
    url,
    urlNormalized: url.replace(/\/$/, ''),
    itemUri: `at://did:plc:backingtest/network.cosmik.card/card${i}`,
    linkUri: `at://did:plc:backingtest/network.cosmik.collectionLink/link${i}`,
    itemType: 'network.cosmik.card',
  };
}

function mockSnapshot(members: read.BackedMember[], complete = true) {
  return vi.spyOn(read, 'snapshotBackedCollection').mockResolvedValue({
    complete,
    members,
    skipped: [],
    typeMix: {},
  });
}

describe('pollBackedMembership — wholesale replace + safety', () => {
  beforeEach(reset);

  it('replaces membership wholesale and merge-upserts stub enrichment rows', async () => {
    mockSnapshot([member('https://a.test/x', 1), member('https://b.test/y', 2)]);
    const res = await pollBackedMembership(env, DID, BACKING, { force: true });
    expect(res).toMatchObject({ polled: true, complete: true, memberCount: 2 });

    const mem = await env.DB.prepare(
      'SELECT url_normalized FROM backed_collection_members WHERE user_did = ? ORDER BY url_normalized'
    )
      .bind(DID)
      .all<{ url_normalized: string }>();
    expect(mem.results.map((r) => r.url_normalized)).toEqual([
      'https://a.test/x',
      'https://b.test/y',
    ]);

    // stub enrichment rows created for each member URL
    const enr = await env.DB.prepare('SELECT COUNT(*) AS n FROM saved_articles WHERE user_did = ?')
      .bind(DID)
      .first<{ n: number }>();
    expect(enr?.n).toBe(2);
  });

  it('a removed-upstream member drops on the next complete poll', async () => {
    mockSnapshot([member('https://a.test/x', 1), member('https://b.test/y', 2)]);
    await pollBackedMembership(env, DID, BACKING, { force: true });

    mockSnapshot([member('https://a.test/x', 1)]); // b removed in the provider UI
    await pollBackedMembership(env, DID, BACKING, { force: true });

    const mem = await env.DB.prepare(
      'SELECT url_normalized FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .all<{ url_normalized: string }>();
    expect(mem.results.map((r) => r.url_normalized)).toEqual(['https://a.test/x']);
  });

  it('an INCOMPLETE snapshot never replaces the last good membership', async () => {
    mockSnapshot([member('https://a.test/x', 1)]);
    await pollBackedMembership(env, DID, BACKING, { force: true });

    mockSnapshot([], false); // truncated/failed: empty + complete:false
    const res = await pollBackedMembership(env, DID, BACKING, { force: true });
    expect(res).toMatchObject({ polled: true, complete: false });

    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(1); // last good membership preserved, not wiped
  });

  it('a tombstoned URL is excluded from the replace (unsave not resurrected)', async () => {
    await env.DB.prepare(
      `INSERT INTO backed_unsave_tombstones (user_did, external_collection, url_normalized, created_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(DID, COLLECTION, 'https://b.test/y', Date.now())
      .run();

    // snapshot still lists b (foreign delete hasn't propagated yet)
    mockSnapshot([member('https://a.test/x', 1), member('https://b.test/y', 2)]);
    await pollBackedMembership(env, DID, BACKING, { force: true });

    const mem = await env.DB.prepare(
      'SELECT url_normalized FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .all<{ url_normalized: string }>();
    expect(mem.results.map((r) => r.url_normalized)).toEqual(['https://a.test/x']);
    // tombstone kept (still present upstream)
    const tomb = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_unsave_tombstones WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(tomb?.n).toBe(1);
  });

  it('clears a tombstone once the snapshot confirms the URL is gone upstream', async () => {
    await env.DB.prepare(
      `INSERT INTO backed_unsave_tombstones (user_did, external_collection, url_normalized, created_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(DID, COLLECTION, 'https://b.test/y', Date.now())
      .run();
    mockSnapshot([member('https://a.test/x', 1)]); // b no longer present
    await pollBackedMembership(env, DID, BACKING, { force: true });

    const tomb = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_unsave_tombstones WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(tomb?.n).toBe(0);
  });

  it('respects the poll gate (no re-snapshot within the window)', async () => {
    const spy = mockSnapshot([member('https://a.test/x', 1)]);
    await pollBackedMembership(env, DID, BACKING, { force: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const res = await pollBackedMembership(env, DID, BACKING); // not forced, within gate
    expect(res.polled).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('force-clears an EXPIRED tombstone (TTL backstop) so a stuck delete cannot hide a URL forever', async () => {
    // A tombstone older than TOMBSTONE_TTL_MS (10 min). The snapshot still lists the
    // URL (the foreign delete never propagated) — without the backstop it would stay
    // suppressed forever. The TTL sweep drops it, so the URL re-enters membership.
    const elevenMinAgo = Date.now() - 11 * 60_000;
    await env.DB.prepare(
      `INSERT INTO backed_unsave_tombstones (user_did, external_collection, url_normalized, created_at)
       VALUES (?, ?, 'https://b.test/y', ?)`
    )
      .bind(DID, COLLECTION, elevenMinAgo)
      .run();
    mockSnapshot([member('https://a.test/x', 1), member('https://b.test/y', 2)]);
    await pollBackedMembership(env, DID, BACKING, { force: true });

    const tomb = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_unsave_tombstones WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(tomb?.n).toBe(0); // expired tombstone swept
    const mem = await env.DB.prepare(
      'SELECT url_normalized FROM backed_collection_members WHERE user_did = ? ORDER BY url_normalized'
    )
      .bind(DID)
      .all<{ url_normalized: string }>();
    // b is no longer suppressed → both present
    expect(mem.results.map((r) => r.url_normalized)).toEqual([
      'https://a.test/x',
      'https://b.test/y',
    ]);
  });

  it('collapses two members sharing a normalized key into one row', async () => {
    // Same article reached via two foreign records — dedup by url_normalized.
    mockSnapshot([member('https://dup.test/a', 1), member('https://dup.test/a', 2)]);
    const res = await pollBackedMembership(env, DID, BACKING, { force: true });
    expect(res.memberCount).toBe(1);
    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(1);
  });
});

describe('extractMissingBackedContent — fill bodies for imported stubs', () => {
  beforeEach(reset);

  const extracted = {
    title: 'Extracted Title',
    author: 'Author',
    description: 'Desc',
    content: '<p>body</p>',
    domain: 'a.test',
    image: null,
    published: null,
    wordCount: 500,
  };

  it('fills body + missing metadata, but keeps the title captured from the foreign record', async () => {
    vi.spyOn(FeedProxyClient.prototype, 'extract').mockResolvedValue(extracted);
    // a Semble-style stub that already has a captured title, no body
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, title, content_type, source, saved_at, created_at)
       VALUES (?, 'rk1', 'https://a.test/x', 'https://a.test/x', 'Card Title', 'webpage', 'url', 200, 200)`
    )
      .bind(DID)
      .run();
    // a Margin-style stub with no title, no body
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, content_type, source, saved_at, created_at)
       VALUES (?, 'rk2', 'https://b.test/y', 'https://b.test/y', 'webpage', 'url', 100, 100)`
    )
      .bind(DID)
      .run();

    const n = await extractMissingBackedContent(env, DID);
    expect(n).toBe(2);

    const a = await env.DB.prepare(
      `SELECT title, content, word_count, content_type FROM saved_articles WHERE user_did = ? AND rkey = 'rk1'`
    )
      .bind(DID)
      .first<{ title: string; content: string; word_count: number; content_type: string }>();
    expect(a?.title).toBe('Card Title'); // captured title preserved (COALESCE keeps it)
    expect(a?.content).toBe('<p>body</p>');
    expect(a?.word_count).toBe(500);
    expect(a?.content_type).toBe('article');

    const b = await env.DB.prepare(
      `SELECT title, content FROM saved_articles WHERE user_did = ? AND rkey = 'rk2'`
    )
      .bind(DID)
      .first<{ title: string; content: string }>();
    expect(b?.title).toBe('Extracted Title'); // no captured title → filled from extraction
    expect(b?.content).toBe('<p>body</p>');
  });

  it('skips rows that already have a body or lack a normalized url', async () => {
    const spy = vi.spyOn(FeedProxyClient.prototype, 'extract').mockResolvedValue(extracted);
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, content, content_type, source, saved_at, created_at)
       VALUES (?, 'rk1', 'https://a.test/x', 'https://a.test/x', 'already here', 'article', 'url', 200, 200)`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, content_type, source, saved_at, created_at)
       VALUES (?, 'rk2', 'https://b.test/y', 'webpage', 'url', 100, 100)`
    )
      .bind(DID)
      .run(); // url_normalized NULL (legacy)

    const n = await extractMissingBackedContent(env, DID);
    expect(n).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('only extracts url/feed sources — a document or share stub is left alone', async () => {
    // A document save's url is a resolved blogs URL (not an extractable article) and a
    // share has no body — extracting either would fetch the wrong content AND flip
    // content_type to 'article'. They must be skipped by the source filter.
    const spy = vi.spyOn(FeedProxyClient.prototype, 'extract').mockResolvedValue(extracted);
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, content_type, source, saved_at, created_at)
       VALUES (?, 'rk1', 'https://blogs.test/doc', 'https://blogs.test/doc', 'document', 'document', 200, 200)`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, content_type, source, saved_at, created_at)
       VALUES (?, 'rk2', 'https://feed.test/a', 'https://feed.test/a', 'webpage', 'feed', 100, 100)`
    )
      .bind(DID)
      .run();

    const n = await extractMissingBackedContent(env, DID);
    expect(n).toBe(1); // only the feed stub
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('https://feed.test/a');
  });

  it('is resilient to an extraction failure: leaves the row and continues', async () => {
    vi.spyOn(FeedProxyClient.prototype, 'extract')
      .mockRejectedValueOnce(new Error('proxy 500'))
      .mockResolvedValue(extracted);
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, title, content_type, source, saved_at, created_at)
       VALUES (?, 'rk1', 'https://fail.test/x', 'https://fail.test/x', 'Keep Me', 'webpage', 'url', 200, 200)`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, content_type, source, saved_at, created_at)
       VALUES (?, 'rk2', 'https://ok.test/y', 'https://ok.test/y', 'webpage', 'url', 100, 100)`
    )
      .bind(DID)
      .run();

    const n = await extractMissingBackedContent(env, DID);
    expect(n).toBe(1); // only the second filled; the failure didn't abort the pass

    const failed = await env.DB.prepare(
      `SELECT title, content FROM saved_articles WHERE user_did = ? AND rkey = 'rk1'`
    )
      .bind(DID)
      .first<{ title: string; content: string | null }>();
    expect(failed?.content).toBeNull(); // body still empty, retried later
    expect(failed?.title).toBe('Keep Me'); // metadata preserved
  });
});

describe('backedUnsave — membership delete + tombstone', () => {
  beforeEach(reset);

  const fakeSession = { did: DID, pdsUrl: 'https://pds.test' } as unknown as Session;
  const fakeCtx = { waitUntil: (_p: Promise<unknown>) => {} } as unknown as ExecutionContext;

  it('removes the membership row, writes a tombstone, and fires the foreign delete', async () => {
    const spy = vi.spyOn(write, 'removeMember').mockResolvedValue(undefined);
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
       VALUES (?, ?, 'https://a.test/x', 'https://a.test/x', 'semble', 'at://card/1', 'at://link/1', NULL)`
    )
      .bind(DID, COLLECTION)
      .run();

    await backedUnsave(env, fakeSession, BACKING, 'https://a.test/x', fakeCtx);

    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(0);
    const tomb = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_unsave_tombstones WHERE user_did = ? AND url_normalized = ?'
    )
      .bind(DID, 'https://a.test/x')
      .first<{ n: number }>();
    expect(tomb?.n).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'semble', { linkUri: 'at://link/1' });
  });

  it('is a no-op when no membership exists for the URL (native-only)', async () => {
    const spy = vi.spyOn(write, 'removeMember').mockResolvedValue(undefined);
    await backedUnsave(env, fakeSession, BACKING, 'https://none.test/x', fakeCtx);
    const tomb = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_unsave_tombstones WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(tomb?.n).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a failing foreign delete is swallowed; local removal + tombstone still stand (re-fires later)', async () => {
    vi.spyOn(write, 'removeMember').mockRejectedValue(new Error('PDS down'));
    // ctx that actually runs the deferred work, so the .catch is exercised.
    const deferred: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => deferred.push(p),
    } as unknown as ExecutionContext;
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
       VALUES (?, ?, 'https://a.test/x', 'https://a.test/x', 'semble', 'at://card/1', 'at://link/1', NULL)`
    )
      .bind(DID, COLLECTION)
      .run();

    await expect(
      backedUnsave(env, fakeSession, BACKING, 'https://a.test/x', ctx)
    ).resolves.toBeUndefined();
    await expect(Promise.all(deferred)).resolves.toBeDefined(); // .catch absorbed the rejection

    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(0); // membership still removed locally (immediate UI removal)
    const tomb = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_unsave_tombstones WHERE user_did = ? AND url_normalized = ?'
    )
      .bind(DID, 'https://a.test/x')
      .first<{ n: number }>();
    expect(tomb?.n).toBe(1); // tombstone persists so the next poll/unsave re-fires the delete
  });
});

describe('listBackedSaved — membership ⋈ enrichment ∪ native-only', () => {
  beforeEach(reset);

  it('joins enrichment onto members and unions native-only saves', async () => {
    // a member with a full enrichment row (extracted body)
    await env.DB.prepare(
      `INSERT INTO saved_articles
         (user_did, rkey, url, url_normalized, title, content, content_type, word_count, source, saved_at, created_at)
       VALUES (?, 'rk1', 'https://a.test/x', 'https://a.test/x', 'Article A', 'BODY', 'article', 1200, 'url', 200, 200)`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
       VALUES (?, ?, 'https://a.test/x', 'https://a.test/x', 'semble', 'at://card/1', 'at://link/1', ?)`
    )
      .bind(DID, COLLECTION, JSON.stringify({ title: 'meta title' }))
      .run();

    // a member with NO enrichment yet — title falls back to membership metadata
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
       VALUES (?, ?, 'https://b.test/y', 'https://b.test/y', 'semble', 'at://card/2', 'at://link/2', ?)`
    )
      .bind(DID, COLLECTION, JSON.stringify({ title: 'B from metadata' }))
      .run();

    // a native-only save (e.g. legacy / upload) not in the collection
    await env.DB.prepare(
      `INSERT INTO saved_articles
         (user_did, rkey, url, url_normalized, title, source, saved_at, created_at)
       VALUES (?, 'rk3', 'https://c.test/z', 'https://c.test/z', 'Native C', 'url', 300, 300)`
    )
      .bind(DID)
      .run();

    const list = await listBackedSaved(env, DID, BACKING);
    const byUrl = Object.fromEntries(list.map((v) => [v.url, v]));

    expect(list).toHaveLength(3);
    // enriched member keeps its extracted body + real title
    expect(byUrl['https://a.test/x']).toMatchObject({
      title: 'Article A',
      content: 'BODY',
      wordCount: 1200,
    });
    // member without enrichment falls back to membership metadata title + foreign uri
    expect(byUrl['https://b.test/y']).toMatchObject({
      title: 'B from metadata',
      content: null,
      uri: 'at://card/2',
    });
    // native-only save is present in the union
    expect(byUrl['https://c.test/z']).toMatchObject({ title: 'Native C' });
  });

  it('does not double-count a legacy save whose URL is also a collection member', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_articles
         (user_did, rkey, url, url_normalized, title, source, saved_at, created_at)
       VALUES (?, 'rk1', 'https://a.test/x', 'https://a.test/x', 'A', 'url', 100, 100)`
    )
      .bind(DID)
      .run();
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
       VALUES (?, ?, 'https://a.test/x', 'https://a.test/x', 'semble', 'at://card/1', 'at://link/1', NULL)`
    )
      .bind(DID, COLLECTION)
      .run();

    const list = await listBackedSaved(env, DID, BACKING);
    expect(list).toHaveLength(1);
  });
});
