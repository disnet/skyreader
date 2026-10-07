import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

// Migration 0089 clears the guessed "View in browser" URL that saves of
// newsletter items copied before the server stopped guessing one, and stamps
// updated_at so clients re-pull the edited rows. It must leave every other save
// alone — above all an RSS save that happens to share the newsletter's guid.

const MIGRATION_0089 = Object.values(
  import.meta.glob('../migrations/0089_newsletter_saves_no_url.sql', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>
)[0];

const ME = 'did:plc:migration0089';
const OTHER = 'did:plc:migration0089other';
const INBOX = 'inbox0089';
const WEB_COPY = 'https://news.example/view?subscriber=abc';

async function runMigration() {
  const statements = MIGRATION_0089.replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await env.DB.batch(statements.map((stmt) => env.DB.prepare(stmt)));
}

async function seedItem(feedUrl: string, guid: string) {
  await env.DB.prepare(
    `INSERT INTO feed_items (feed_url, guid, item_json, published_at, first_seen_at, content_hash)
     VALUES (?, ?, '{}', 0, 0, 'h')`
  )
    .bind(feedUrl, guid)
    .run();
}

async function seedSave(did: string, rkey: string, url: string, source: string, guid: string) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, url, title, source, item_guid, saved_at, created_at)
     VALUES (?, ?, ?, 't', ?, ?, 0, 0)`
  )
    .bind(did, rkey, url, source, guid)
    .run();
}

async function saveRow(did: string, rkey: string) {
  return env.DB.prepare(
    'SELECT url, updated_at FROM saved_articles WHERE user_did = ? AND rkey = ?'
  )
    .bind(did, rkey)
    .first<{ url: string; updated_at: number | null }>();
}

describe('migration 0089: newsletter saves lose their guessed web URL', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM saved_articles WHERE user_did IN (?, ?)').bind(ME, OTHER),
      env.DB.prepare("DELETE FROM feed_items WHERE guid LIKE 'm0089-%'"),
      env.DB.prepare('DELETE FROM newsletter_inboxes WHERE user_did = ?').bind(ME),
      env.DB.prepare(
        "INSERT INTO newsletter_inboxes (user_did, inbox_id, address_token) VALUES (?, ?, 'tok0089')"
      ).bind(ME, INBOX),
    ]);
    await seedItem(`newsletter:${INBOX}/x@news.example`, 'm0089-issue');
    await seedItem('https://rss.example/feed.xml', 'm0089-post');
  });

  it('clears the URL and stamps updated_at on a saved newsletter issue', async () => {
    await seedSave(ME, 'nl', WEB_COPY, 'feed', 'm0089-issue');
    const before = Date.now();

    await runMigration();

    const row = await saveRow(ME, 'nl');
    expect(row?.url).toBe('');
    expect(row?.updated_at).toBeGreaterThanOrEqual(before - 1000);
  });

  it('leaves RSS saves, URL saves and other readers alone', async () => {
    await seedSave(ME, 'rss', 'https://rss.example/1', 'feed', 'm0089-post');
    await seedSave(ME, 'url', WEB_COPY, 'url', 'm0089-issue');
    // Another reader's save of the same guid isn't from this inbox.
    await seedSave(OTHER, 'nl', WEB_COPY, 'feed', 'm0089-issue');

    await runMigration();

    expect((await saveRow(ME, 'rss'))?.url).toBe('https://rss.example/1');
    expect((await saveRow(ME, 'url'))?.url).toBe(WEB_COPY);
    expect((await saveRow(OTHER, 'nl'))?.url).toBe(WEB_COPY);
    expect((await saveRow(ME, 'rss'))?.updated_at).toBeNull();
  });
});
