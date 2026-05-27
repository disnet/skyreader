import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

/**
 * The dedup migration (0052) runs as part of test setup. By the time these
 * tests run, the partial UNIQUE indexes already exist. We re-create the
 * scenario by seeding via raw INSERTs that bypass app-level normalization
 * (still allowed because the indexes only fire on exact-match collisions),
 * then assert the indexes prevent the conflicting writes that would create
 * duplicates.
 */

const TEST_DID = 'did:plc:dedupmigration';

describe('Subscription dedup migration', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
    )
      .bind(TEST_DID, 'd.bsky.social', 'https://test.pds.example')
      .run();
  });

  it('partial UNIQUE index prevents a second RSS row with the same (user_did, feed_url)', async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, created_at)
       VALUES (?, ?, ?, unixepoch())`
    )
      .bind(TEST_DID, `at://${TEST_DID}/c/aaaaaaaaaaaaa`, 'https://example.com/feed')
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, created_at)
         VALUES (?, ?, ?, unixepoch())`
      )
        .bind(TEST_DID, `at://${TEST_DID}/c/bbbbbbbbbbbbb`, 'https://example.com/feed')
        .run()
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('partial UNIQUE index does not block AT Proto rows with empty feed_url', async () => {
    // Two AT Proto shares subs for two distinct subjects — both should succeed.
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
       VALUES (?, ?, '', 'atproto.shares', ?, unixepoch())`
    )
      .bind(TEST_DID, `at://${TEST_DID}/c/atp1111111111`, 'did:plc:subjectone001')
      .run();

    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
       VALUES (?, ?, '', 'atproto.shares', ?, unixepoch())`
    )
      .bind(TEST_DID, `at://${TEST_DID}/c/atp2222222222`, 'did:plc:subjecttwo001')
      .run();

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM subscriptions_cache WHERE user_did = ?`
    )
      .bind(TEST_DID)
      .first<{ c: number }>();
    expect(rows?.c).toBe(2);
  });

  it('AT Proto UNIQUE index blocks a second row for the same (sourceType, subjectDid)', async () => {
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
       VALUES (?, ?, '', 'atproto.shares', ?, unixepoch())`
    )
      .bind(TEST_DID, `at://${TEST_DID}/c/atp3333333333`, 'did:plc:samesubject01')
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, source_type, subject_did, created_at)
         VALUES (?, ?, '', 'atproto.shares', ?, unixepoch())`
      )
        .bind(TEST_DID, `at://${TEST_DID}/c/atp4444444444`, 'did:plc:samesubject01')
        .run()
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('UNIQUE indexes are scoped per user_did', async () => {
    const otherDid = 'did:plc:otherdedup00';
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())`
    )
      .bind(otherDid, 'o.bsky.social', 'https://test.pds.example')
      .run();

    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, created_at)
       VALUES (?, ?, ?, unixepoch())`
    )
      .bind(TEST_DID, `at://${TEST_DID}/c/scopedrkey001`, 'https://example.com/feed')
      .run();

    // Different user, same URL → must succeed.
    await env.DB.prepare(
      `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, created_at)
       VALUES (?, ?, ?, unixepoch())`
    )
      .bind(otherDid, `at://${otherDid}/c/scopedrkey002`, 'https://example.com/feed')
      .run();
  });
});
