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
}

export async function seedSavedArticle(
  user: TestUser,
  opts: SeedSavedArticleOpts
): Promise<string> {
  const rkey = opts.rkey || generateTid();
  const recordUri = `at://${user.did}/app.skyreader.feed.saved/${rkey}`;
  const nowMs = Date.now();
  const source = opts.source || 'url';
  const domain = opts.domain ? `'${opts.domain}'` : 'NULL';
  const contentType = opts.contentType || 'webpage';
  const itemGuid = opts.itemGuid ? `'${opts.itemGuid}'` : 'NULL';

  await execD1([
    `INSERT OR REPLACE INTO saved_articles (user_did, rkey, record_uri, url, title, source, item_guid, domain, content_type, saved_at, created_at) VALUES ('${user.did}', '${rkey}', '${recordUri}', '${opts.url}', '${opts.title}', '${source}', ${itemGuid}, ${domain}, '${contentType}', ${nowMs}, ${nowMs})`,
  ]);

  return rkey;
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
