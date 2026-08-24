const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://127.0.0.1:8787';

/**
 * Run SQL against the backend's own D1 binding via the test-only `/api/test/exec`
 * endpoint (gated behind E2E_TEST_MODE). Going through the running worker means a
 * single process owns the local SQLite file — unlike shelling out to a separate
 * `wrangler d1 execute`, which raced the dev server and intermittently failed with
 * SQLITE_BUSY ("database is locked"). Statements run as one atomic batch.
 */
async function execD1(statements: string[]) {
  const res = await fetch(`${BACKEND_URL}/api/test/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statements }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Test D1 exec failed (${res.status}): ${text}`);
  }
}

/** Quote a string for the small SQL fixtures sent through /api/test/exec. */
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNullableString(value: string | null | undefined): string {
  return value == null ? 'NULL' : sqlString(value);
}

function sqlNullableInteger(value: number | null | undefined): string {
  if (value == null) return 'NULL';
  if (!Number.isFinite(value)) throw new Error('SQL fixture integer must be finite');
  return String(Math.trunc(value));
}

export interface TestUser {
  did: string;
  handle: string;
  sessionId: string;
}

export async function seedTestUser(): Promise<TestUser> {
  const did = `did:plc:test${Date.now()}`;
  const handle = `testuser-${Date.now()}.test`;
  const sessionId = `test-session-${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const futureExpiryMs = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days from now (milliseconds, matching Date.now())

  await execD1([
    // Insert user (pds_url is NOT NULL, timestamps are unix integers)
    `INSERT OR REPLACE INTO users (did, handle, pds_url, created_at, updated_at) VALUES ('${did}', '${handle}', 'https://bsky.social', ${now}, ${now})`,
    // Insert session — columns: session_id, did, handle, pds_url, access_token,
    // refresh_token, dpop_private_key, expires_at, created_at
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, created_at) VALUES ('${sessionId}', '${did}', '${handle}', 'https://bsky.social', 'test-access-token', 'test-refresh-token', '{}', ${futureExpiryMs}, ${now})`,
    // Insert user_settings with PDS sync disabled so the app doesn't try to talk to a real PDS
    `INSERT OR REPLACE INTO user_settings (user_did, pds_sync_enabled, updated_at) VALUES ('${did}', 0, ${now})`,
  ]);

  return { did, handle, sessionId };
}

export interface SeedSubscriptionOpts {
  feedUrl: string;
  title: string;
  rkey?: string;
  customTitle?: string;
  customIconUrl?: string;
}

/**
 * Generate a valid AT Protocol TID (lowercase alphanumeric, 13+ chars).
 * Real TIDs are base32-sortable timestamps but the backend only validates the regex.
 */
function generateTid(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let tid = '';
  for (let i = 0; i < 15; i++) {
    tid += chars[Math.floor(Math.random() * chars.length)];
  }
  return tid;
}

export async function seedSubscription(
  user: TestUser,
  opts: SeedSubscriptionOpts
): Promise<string> {
  const rkey = opts.rkey || generateTid();
  const recordUri = `at://${user.did}/app.skyreader.feed.subscription/${rkey}`;
  const now = Math.floor(Date.now() / 1000);

  const customTitleVal = opts.customTitle ? `'${opts.customTitle}'` : 'NULL';
  const customIconVal = opts.customIconUrl ? `'${opts.customIconUrl}'` : 'NULL';

  await execD1([
    `INSERT OR REPLACE INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, custom_title, custom_icon_url) VALUES ('${user.did}', '${recordUri}', '${opts.feedUrl}', '${opts.title}', ${now}, ${customTitleVal}, ${customIconVal})`,
  ]);

  return rkey;
}

export interface SeedSavedArticleOpts {
  url: string;
  title: string;
  rkey?: string;
  source?: string;
  itemGuid?: string;
  domain?: string;
  contentType?: string;
  content?: string;
  wordCount?: number;
  author?: string;
  description?: string;
}

export async function seedSavedArticle(
  user: TestUser,
  opts: SeedSavedArticleOpts
): Promise<string> {
  const rkey = opts.rkey || generateTid();
  const recordUri = `at://${user.did}/app.skyreader.feed.saved/${rkey}`;
  const nowMs = Date.now();
  const source = opts.source || 'url';
  const domain = sqlNullableString(opts.domain);
  const contentType = opts.contentType || 'webpage';
  const itemGuid = sqlNullableString(opts.itemGuid);
  const content = sqlNullableString(opts.content);
  const author = sqlNullableString(opts.author);
  const description = sqlNullableString(opts.description);
  const wordCount = sqlNullableInteger(opts.wordCount);

  await execD1([
    `INSERT OR REPLACE INTO saved_articles (user_did, rkey, record_uri, url, title, author, description, content, word_count, source, item_guid, domain, content_type, saved_at, created_at) VALUES (${sqlString(user.did)}, ${sqlString(rkey)}, ${sqlString(recordUri)}, ${sqlString(opts.url)}, ${sqlString(opts.title)}, ${author}, ${description}, ${content}, ${wordCount}, ${sqlString(source)}, ${itemGuid}, ${domain}, ${sqlString(contentType)}, ${nowMs}, ${nowMs})`,
  ]);

  return rkey;
}

export interface SeedFeedItemOpts {
  guid: string;
  title: string;
  url?: string;
  publishedAt?: string;
  summary?: string;
  content?: string;
  contentTruncated?: boolean;
}

/**
 * Seed the server-side archive the timeline serves from: a `feeds` row plus its
 * `feed_items`. Feed-scoped rather than user-scoped (the archive is shared by
 * every subscriber), so it's cleaned up with `cleanupFeedItems`.
 */
export async function seedFeedItems(
  feedUrl: string,
  items: SeedFeedItemOpts[],
  opts: { title?: string; siteUrl?: string } = {}
): Promise<void> {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);

  const statements = [
    `INSERT OR REPLACE INTO feeds (feed_url, title, site_url, last_ingest_at, created_at) VALUES (${sqlString(feedUrl)}, ${sqlNullableString(opts.title ?? null)}, ${sqlNullableString(opts.siteUrl ?? null)}, ${nowSeconds}, ${nowSeconds})`,
    // Stand in for the crawler's check-in. Without a fresh heartbeat the timeline
    // reports `ingestActive: false` and the client (correctly) stays on the legacy
    // batch path, which is not what these tests are exercising.
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('crawler_heartbeat_at', ${sqlString(String(nowSeconds))}, ${nowSeconds}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    // The other half of the same gate: a heartbeat says a crawler is attached,
    // this says readers may use what it wrote. Migration 0071 leaves it open on a
    // fresh database, but a test DB that predates the migration with users in it
    // starts closed — so set it rather than depend on which case this one is.
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('timeline_enabled', '1', ${nowSeconds}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ];

  items.forEach((item, index) => {
    const publishedAt = item.publishedAt ?? new Date(nowMs - index * 60_000).toISOString();
    const itemJson = JSON.stringify({
      guid: item.guid,
      url: item.url ?? `https://example.com/${item.guid}`,
      title: item.title,
      summary: item.summary ?? `Summary for ${item.title}`,
      ...(item.content == null ? {} : { content: item.content }),
      ...(item.contentTruncated == null ? {} : { contentTruncated: item.contentTruncated }),
      publishedAt,
    });
    statements.push(
      `INSERT OR REPLACE INTO feed_items (feed_url, guid, item_json, published_at, first_seen_at, content_hash) VALUES (${sqlString(feedUrl)}, ${sqlString(item.guid)}, ${sqlString(itemJson)}, ${Date.parse(publishedAt)}, ${nowMs}, ${sqlString(`hash-${item.guid}`)})`
    );
  });

  await execD1(statements);
}

export async function cleanupFeedItems(feedUrl: string): Promise<void> {
  await execD1([
    `DELETE FROM feed_items WHERE feed_url = ${sqlString(feedUrl)}`,
    `DELETE FROM feeds WHERE feed_url = ${sqlString(feedUrl)}`,
    `DELETE FROM sync_state WHERE key = 'crawler_heartbeat_at'`,
  ]);
}

export interface SeedItemLabelOpts {
  itemKey: string;
  itemType: string;
  label: string;
  props?: string;
  rkey?: string;
}

export async function seedItemLabel(user: TestUser, opts: SeedItemLabelOpts): Promise<string> {
  const rkey = opts.rkey || generateTid();
  const now = Math.floor(Date.now() / 1000);
  const props = opts.props ? `'${opts.props}'` : 'NULL';

  await execD1([
    `INSERT OR REPLACE INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at) VALUES ('${user.did}', '${opts.itemKey}', '${opts.itemType}', '${opts.label}', ${props}, '${rkey}', ${now}, ${now})`,
  ]);

  return rkey;
}

export async function cleanupTestData(user: TestUser) {
  await execD1([
    `DELETE FROM item_labels_cache WHERE user_did = '${user.did}'`,
    `DELETE FROM saved_articles WHERE user_did = '${user.did}'`,
    `DELETE FROM subscriptions_cache WHERE user_did = '${user.did}'`,
    `DELETE FROM user_settings WHERE user_did = '${user.did}'`,
    `DELETE FROM sessions WHERE did = '${user.did}'`,
    `DELETE FROM users WHERE did = '${user.did}'`,
  ]);
}
