import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

// Guards the (user_did, source_type, feed_url) unique index added in migration
// 0054 — the DB-level backstop the Atmospheric subscription import relies on to
// stay idempotent under concurrent syncs. The reconcile loop reads
// `meta.changes === 0` from an ignored insert to skip duplicate follow-up work,
// so these tests pin both the constraint and that signal.

const TEST_DID = 'did:plc:uniqueidx';
const PUB_URI = 'at://did:plc:author/site.standard.publication/links';

async function insertDocSub(rkey: string, feedUrl: string) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO subscriptions_cache
       (user_did, record_uri, feed_url, title, created_at, source_type, subject_did)
     VALUES (?, ?, ?, ?, unixepoch(), 'atproto.documents', 'did:plc:author')`
  )
    .bind(TEST_DID, `at://${TEST_DID}/app.skyreader.feed.subscription/${rkey}`, feedUrl, 'Links')
    .run();
}

describe('subscriptions_cache uniqueness', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM subscriptions_cache WHERE user_did = ?').bind(TEST_DID).run();
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(TEST_DID).run();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
    )
      .bind(TEST_DID, 'uniqueidx.bsky.social', 'https://test.pds.example')
      .run();
  });

  it('ignores a duplicate (user, source_type, feed_url) insert and reports zero changes', async () => {
    const first = await insertDocSub('rkeyA', PUB_URI);
    expect(first.meta.changes).toBe(1);

    // A second, concurrent reconcile inserting the same publication under a fresh
    // throwaway rkey must be ignored, not duplicated.
    const second = await insertDocSub('rkeyB', PUB_URI);
    expect(second.meta.changes).toBe(0);

    const rows = await env.DB.prepare(
      `SELECT record_uri FROM subscriptions_cache WHERE user_did = ? AND feed_url = ?`
    )
      .bind(TEST_DID, PUB_URI)
      .all();
    expect(rows.results).toHaveLength(1);
    // The original row (and its rkey) is the survivor.
    expect(rows.results[0].record_uri).toContain('rkeyA');
  });

  it('keeps two publications owned by the same author as distinct rows', async () => {
    const other = 'at://did:plc:author/site.standard.publication/notes';
    const a = await insertDocSub('rkeyA', PUB_URI);
    const b = await insertDocSub('rkeyB', other);
    expect(a.meta.changes).toBe(1);
    expect(b.meta.changes).toBe(1);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM subscriptions_cache WHERE user_did = ?`
    )
      .bind(TEST_DID)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});
