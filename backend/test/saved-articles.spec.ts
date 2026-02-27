import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

const TEST_DID = 'did:plc:savedtest123';

// Mirrors the INSERT used in JetstreamPoller.processSavedEvent
async function insertSavedArticle(
  did: string,
  rkey: string,
  url: string,
  opts: { title?: string; contentType?: string } = {}
) {
  const recordUri = `at://${did}/app.skyreader.feed.saved/${rkey}`;
  return env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, description, content_type, domain, image, word_count, published_at, saved_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_did, rkey) DO NOTHING`
  )
    .bind(
      did,
      rkey,
      recordUri,
      url,
      opts.title || null,
      null,
      opts.contentType || 'webpage',
      null,
      null,
      null,
      null,
      Date.now(),
      Date.now()
    )
    .run();
}

describe('Saved Articles - ON CONFLICT(user_did, rkey)', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM saved_articles').run();
  });

  it('inserts a new saved article', async () => {
    const result = await insertSavedArticle(TEST_DID, 'abc123', 'https://example.com/article');
    expect(result.meta.changes).toBe(1);

    const row = await env.DB.prepare('SELECT * FROM saved_articles WHERE user_did = ?')
      .bind(TEST_DID)
      .first();
    expect(row).not.toBeNull();
    expect(row!.rkey).toBe('abc123');
    expect(row!.url).toBe('https://example.com/article');
  });

  it('does nothing on duplicate (user_did, rkey)', async () => {
    await insertSavedArticle(TEST_DID, 'abc123', 'https://example.com/article', {
      title: 'Original',
    });

    // Same user_did + rkey, different url/title — should be ignored
    const result = await insertSavedArticle(TEST_DID, 'abc123', 'https://example.com/other', {
      title: 'Updated',
    });
    expect(result.meta.changes).toBe(0);

    // Verify the original row is unchanged
    const row = await env.DB.prepare('SELECT * FROM saved_articles WHERE user_did = ? AND rkey = ?')
      .bind(TEST_DID, 'abc123')
      .first();
    expect(row!.title).toBe('Original');
    expect(row!.url).toBe('https://example.com/article');
  });

  it('allows same rkey for different users', async () => {
    const otherDid = 'did:plc:otheruser456';
    await insertSavedArticle(TEST_DID, 'abc123', 'https://example.com/article');
    const result = await insertSavedArticle(otherDid, 'abc123', 'https://example.com/article');
    expect(result.meta.changes).toBe(1);

    const count = await env.DB.prepare('SELECT COUNT(*) as cnt FROM saved_articles').first<{
      cnt: number;
    }>();
    expect(count!.cnt).toBe(2);
  });

  it('allows same user to save different URLs (no url uniqueness)', async () => {
    await insertSavedArticle(TEST_DID, 'rkey1', 'https://example.com/article');
    // Same URL, different rkey — should succeed (url is no longer unique)
    const result = await insertSavedArticle(TEST_DID, 'rkey2', 'https://example.com/article');
    expect(result.meta.changes).toBe(1);

    const count = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM saved_articles WHERE user_did = ?'
    )
      .bind(TEST_DID)
      .first<{ cnt: number }>();
    expect(count!.cnt).toBe(2);
  });

  it('deletes by user_did and rkey', async () => {
    await insertSavedArticle(TEST_DID, 'abc123', 'https://example.com/article');
    await insertSavedArticle(TEST_DID, 'def456', 'https://example.com/other');

    // Mirrors JetstreamPoller delete path
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ? AND rkey = ?')
      .bind(TEST_DID, 'abc123')
      .run();

    const remaining = await env.DB.prepare('SELECT rkey FROM saved_articles WHERE user_did = ?')
      .bind(TEST_DID)
      .all<{ rkey: string }>();
    expect(remaining.results).toHaveLength(1);
    expect(remaining.results[0].rkey).toBe('def456');
  });
});
