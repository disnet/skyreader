import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

// Migration 0088 clears the guessed "View in browser" URL newsletter items
// carried before the email became the article. Saves keep the URL they were
// made with.

// Load the real migration so the test tracks the shipped SQL, not a copy.
const MIGRATION_0088 = Object.values(
  import.meta.glob('../migrations/0088_newsletter_items_no_url.sql', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>
)[0];

const DID = 'did:plc:migration0088';
const NL_FEED = 'newsletter:inbox1/news@example.com';
const RSS_FEED = 'https://blog.example/feed';
const WEB_COPY = 'https://news.example/view?sub=123';

// Apply the migration the way test/setup.ts does: strip comments, split on `;`.
async function runMigration() {
  const statements = MIGRATION_0088.replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await env.DB.batch(statements.map((stmt) => env.DB.prepare(stmt)));
}

async function seedItem(feedUrl: string, guid: string, url: string) {
  await env.DB.prepare(
    `INSERT INTO feed_items (feed_url, guid, item_json, first_seen_at, content_hash)
     VALUES (?, ?, ?, 0, 'h')`
  )
    .bind(feedUrl, guid, JSON.stringify({ guid, url, title: 't' }))
    .run();
}

async function seedSave(rkey: string, guid: string, url: string, urlNormalized: string | null) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, source, item_guid)
     VALUES (?, ?, ?, ?, 'feed', ?)`
  )
    .bind(DID, rkey, url, urlNormalized, guid)
    .run();
}

async function itemUrl(feedUrl: string, guid: string) {
  const row = await env.DB.prepare(
    `SELECT json_extract(item_json, '$.url') AS url FROM feed_items WHERE feed_url = ? AND guid = ?`
  )
    .bind(feedUrl, guid)
    .first<{ url: string }>();
  return row?.url;
}

async function save(rkey: string) {
  return env.DB.prepare(
    'SELECT url, url_normalized FROM saved_articles WHERE user_did = ? AND rkey = ?'
  )
    .bind(DID, rkey)
    .first<{ url: string; url_normalized: string | null }>();
}

describe('migration 0088: newsletter items have no web URL', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM feed_items WHERE feed_url IN (?, ?)').bind(NL_FEED, RSS_FEED),
      env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID),
    ]);
  });

  it('clears newsletter items and leaves feed items alone', async () => {
    await seedItem(NL_FEED, 'nl-1@news', WEB_COPY);
    await seedItem(RSS_FEED, 'rss-1', 'https://blog.example/p/1');

    await runMigration();

    expect(await itemUrl(NL_FEED, 'nl-1@news')).toBe('');
    expect(await itemUrl(RSS_FEED, 'rss-1')).toBe('https://blog.example/p/1');
  });

  it('leaves saves alone', async () => {
    await seedItem(NL_FEED, 'nl-2@news', WEB_COPY);
    await seedSave('3kaaaaaaaaaa1', 'nl-2@news', WEB_COPY, 'news.example/view?sub=123');

    await runMigration();

    expect(await save('3kaaaaaaaaaa1')).toMatchObject({
      url: WEB_COPY,
      url_normalized: 'news.example/view?sub=123',
    });
  });
});
