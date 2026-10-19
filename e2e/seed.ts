import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://127.0.0.1:8787';

// How long to wait for the backend to answer /api/health: long enough for
// e2e/backend-supervisor.sh to bring a crashed wrangler dev back up, and short
// enough to give up inside the 30s test timeout (fixture time counts toward it).
const BACKEND_WAIT_MS = 20_000;

/**
 * Written once the backend has stayed down for a full BACKEND_WAIT_MS, so the
 * remaining tests (each retry runs in a fresh worker process) fail at once
 * instead of each waiting out the same timeout. global-setup clears it.
 */
export const BACKEND_DOWN_MARKER = path.join(tmpdir(), 'skyreader-e2e-backend-down');

async function backendHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the backend to answer before talking to it. When wrangler dev crashes
 * mid-run, the supervisor restarts it, and this turns the crash into a short
 * pause rather than a connection error for every test that follows.
 */
async function waitForBackend(): Promise<void> {
  if (await backendHealthy()) return;
  const downError = new Error(
    `Backend at ${BACKEND_URL} is not responding: wrangler dev crashed and did not come back. ` +
      'In CI, the wrangler-logs-* artifact has the crash; locally, see ~/.config/.wrangler/logs/.'
  );
  if (existsSync(BACKEND_DOWN_MARKER)) throw downError;
  const deadline = Date.now() + BACKEND_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await backendHealthy()) return;
  }
  writeFileSync(BACKEND_DOWN_MARKER, new Date().toISOString());
  throw downError;
}

/**
 * Run SQL against the backend's own D1 binding via the test-only `/api/test/exec`
 * endpoint (gated behind E2E_TEST_MODE). Going through the running worker means a
 * single process owns the local SQLite file — unlike shelling out to a separate
 * `wrangler d1 execute`, which raced the dev server and intermittently failed with
 * SQLITE_BUSY ("database is locked"). Statements run as one atomic batch.
 */
async function execD1(statements: string[]) {
  await waitForBackend();
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
  /** The folder it's filed in. */
  category?: string;
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
    `INSERT OR REPLACE INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, custom_title, custom_icon_url, category) VALUES ('${user.did}', '${recordUri}', '${opts.feedUrl}', '${opts.title}', ${now}, ${customTitleVal}, ${customIconVal}, ${sqlNullableString(opts.category)})`,
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
  savedAt?: number;
}

export async function seedSavedArticle(
  user: TestUser,
  opts: SeedSavedArticleOpts
): Promise<string> {
  const rkey = opts.rkey || generateTid();
  const recordUri = `at://${user.did}/app.skyreader.feed.saved/${rkey}`;
  const nowMs = opts.savedAt ?? Date.now();
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

export interface SeedShareDraftOpts {
  articleUrl: string;
  articleTitle?: string;
  text: string;
  /** Client ms clock. Drives last-write-wins and the drafts-list sort. */
  updatedAt?: number;
}

/**
 * Write a share draft straight into D1, standing in for "the user typed this on
 * another device." The `draft` column is the opaque ShareDraft blob the client
 * stores; the backend never interprets it.
 */
export async function seedShareDraft(user: TestUser, opts: SeedShareDraftOpts): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const updatedAt = opts.updatedAt ?? Date.now();
  const draft = JSON.stringify({
    articleUrl: opts.articleUrl,
    articleTitle: opts.articleTitle,
    blocks: [{ kind: 'text', text: opts.text }],
    createdAt: updatedAt,
    updatedAt,
  });

  await execD1([
    `INSERT OR REPLACE INTO share_drafts (user_did, article_url, draft, client_updated_at, created_at, updated_at) VALUES (${sqlString(user.did)}, ${sqlString(opts.articleUrl)}, ${sqlString(draft)}, ${updatedAt}, ${nowSeconds}, ${nowSeconds})`,
  ]);
}

export interface SeedFollowLinkShare {
  url: string;
  sharerDid: string;
  sharerName: string;
  title?: string;
  description?: string;
  thumb?: string;
  text?: string;
  kind?: 'post' | 'quote' | 'repost';
  /** How long ago it was shared, in ms. */
  ageMs?: number;
}

const FOLLOWS_LINKS_SCOPE = 'rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app%23bsky_appview';

/**
 * Stand in for a timeline refresh that already ran: grant the session the
 * getTimeline scope, write the shares, and stamp the sync row fresh and complete
 * so no request walks the (fake) PDS. See docs/plans/FOLLOWS_LINKS_PLAN.md.
 */
export async function seedFollowLinks(
  user: TestUser,
  shares: SeedFollowLinkShare[]
): Promise<void> {
  const now = Date.now();
  await execD1([
    `UPDATE sessions SET granted_scopes = ${sqlString(
      `atproto repo:app.skyreader.feed.subscription repo:app.skyreader.social.follow ${FOLLOWS_LINKS_SCOPE}`
    )} WHERE session_id = ${sqlString(user.sessionId)}`,
    `INSERT OR REPLACE INTO follow_link_sync (user_did, last_poll_at, newest_seen_at, complete) VALUES (${sqlString(user.did)}, ${now}, ${now}, 1)`,
    ...shares.map((s, i) => {
      const normalized = s.url.replace(/\/$/, '');
      return `INSERT INTO follow_link_shares (user_did, post_uri, sharer_did, kind, url, url_normalized, post_text, card_title, card_description, card_thumb, sharer_handle, sharer_name, shared_at) VALUES (${sqlString(user.did)}, ${sqlString(`at://${s.sharerDid}/app.bsky.feed.post/${i}`)}, ${sqlString(s.sharerDid)}, ${sqlString(s.kind ?? 'post')}, ${sqlString(s.url)}, ${sqlString(normalized)}, ${sqlNullableString(s.text)}, ${sqlNullableString(s.title)}, ${sqlNullableString(s.description)}, ${sqlNullableString(s.thumb)}, NULL, ${sqlString(s.sharerName)}, ${now - (s.ageMs ?? 60 * 60 * 1000)})`;
    }),
  ]);
}

export async function cleanupTestData(user: TestUser) {
  await execD1([
    `DELETE FROM channel_match_sources WHERE user_did = '${user.did}'`,
    `DELETE FROM channel_matches WHERE user_did = '${user.did}'`,
    `DELETE FROM saved_queries WHERE user_did = '${user.did}'`,
    `DELETE FROM channels WHERE user_did = '${user.did}'`,
    `DELETE FROM item_labels_cache WHERE user_did = '${user.did}'`,
    `DELETE FROM saved_articles WHERE user_did = '${user.did}'`,
    `DELETE FROM shelf_collection_items WHERE user_did = '${user.did}'`,
    `DELETE FROM shelf_collections WHERE user_did = '${user.did}'`,
    `DELETE FROM share_drafts WHERE user_did = '${user.did}'`,
    `DELETE FROM follow_link_shares WHERE user_did = '${user.did}'`,
    `DELETE FROM follow_link_sync WHERE user_did = '${user.did}'`,
    `DELETE FROM subscriptions_cache WHERE user_did = '${user.did}'`,
    `DELETE FROM user_settings WHERE user_did = '${user.did}'`,
    `DELETE FROM sessions WHERE did = '${user.did}'`,
    `DELETE FROM users WHERE did = '${user.did}'`,
  ]);
}

/**
 * Give `user` full-text search: the Supporter plan and the environment's
 * operator switch (`sync_state.search_enabled`). The switch is global, so pair
 * this with `disableSearch()` in cleanup; other specs' users are free-tier and
 * never see search either way.
 */
/** Put `user` on the Supporter plan (PDFs, newsletters, search entitlement). */
export async function makeSupporter(user: TestUser): Promise<void> {
  await execD1([`UPDATE users SET tier = 'supporter' WHERE did = ${sqlString(user.did)}`]);
}

export async function enableSearchFor(user: TestUser): Promise<void> {
  await execD1([`UPDATE users SET tier = 'supporter' WHERE did = ${sqlString(user.did)}`]);
  await enableSearchSwitch();
}

/** Just the environment's operator switch, leaving every plan as it is. */
export async function enableSearchSwitch(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await execD1([
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('search_enabled', '1', ${now}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ]);
}

export async function disableSearch(): Promise<void> {
  await execD1([`DELETE FROM sync_state WHERE key = 'search_enabled'`]);
}

/**
 * Give `user` saved searches: the Supporter plan and the environment's operator
 * switch (`sync_state.saved_search_enabled`). The switch is global; pair it with
 * `disableSavedSearch()` in cleanup.
 */
export async function enableSavedSearchFor(user: TestUser): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await execD1([
    `UPDATE users SET tier = 'supporter' WHERE did = ${sqlString(user.did)}`,
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('saved_search_enabled', '1', ${now}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ]);
}

/** Saved searches on here, with the user's plan left as it is. */
export async function enableSavedSearchSwitch(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await execD1([
    `INSERT INTO sync_state (key, value, updated_at) VALUES ('saved_search_enabled', '1', ${now}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ]);
}

export async function disableSavedSearch(): Promise<void> {
  await execD1([`DELETE FROM sync_state WHERE key = 'saved_search_enabled'`]);
}

export interface SeedSearchChannelOpts {
  uuid: string;
  name: string;
  query: string;
  /** 'pending' while it's still looking back; the default is done. */
  backfill?: 'pending' | 'done';
}

/**
 * A channel that is a saved search over all sources, as the server holds one
 * after its write: the channel row and its `saved_queries` mirror. (The PUT the
 * app sends writes both; seeding goes straight to D1, so it writes both too.)
 */
export async function seedSearchChannel(
  user: TestUser,
  opts: SeedSearchChannelOpts
): Promise<void> {
  const now = Date.now();
  const config = JSON.stringify({
    mode: 'feed',
    sourceMode: 'all',
    sourceKeys: [],
    query: opts.query,
    readFilter: 'all',
    sortOrder: 'newest',
    filterVersion: 2,
  });
  await execD1([
    `INSERT OR REPLACE INTO channels (uuid, user_did, name, config, position, created_at, updated_at) VALUES (${sqlString(opts.uuid)}, ${sqlString(user.did)}, ${sqlString(opts.name)}, ${sqlString(config)}, 0, ${now}, ${now})`,
    `INSERT OR REPLACE INTO saved_queries (user_did, channel_uuid, query, fts_query, source_mode, source_keys, backfill_state, created_at, updated_at) VALUES (${sqlString(user.did)}, ${sqlString(opts.uuid)}, ${sqlString(opts.query)}, ${sqlString(`"${opts.query}"`)}, 'all', '[]', ${sqlString(opts.backfill ?? 'done')}, ${now}, ${now})`,
  ]);
}

/** A channel row as the server holds one, with `config` as the app writes it. */
export async function seedChannel(
  user: TestUser,
  opts: { uuid: string; name: string; config: Record<string, unknown>; position?: number }
): Promise<void> {
  const now = Date.now();
  await execD1([
    `INSERT OR REPLACE INTO channels (uuid, user_did, name, config, position, created_at, updated_at) VALUES (${sqlString(opts.uuid)}, ${sqlString(user.did)}, ${sqlString(opts.name)}, ${sqlString(JSON.stringify(opts.config))}, ${opts.position ?? 0}, ${now}, ${now})`,
  ]);
}

/** A Shelf collection with no members, at `position`. */
export async function seedShelfCollection(
  user: TestUser,
  opts: { id: string; name: string; position: number }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await execD1([
    `INSERT INTO shelf_collections (user_did, id, name, description, position, created_at, updated_at) VALUES (${sqlString(user.did)}, ${sqlString(opts.id)}, ${sqlString(opts.name)}, NULL, ${opts.position}, ${now}, ${now})`,
  ]);
}

export interface SeedChannelMatchOpts {
  /** A seeded feed item's guid (seedFeedItems), matched in `feedUrl`. */
  guid: string;
  feedUrl: string;
  url: string;
  /** The passage, with the matched words in [brackets]. */
  snippet: string;
  publishedAt: number;
}

/** What the matcher would have written for these feed items. */
export async function seedChannelMatches(
  user: TestUser,
  channelUuid: string,
  matches: SeedChannelMatchOpts[]
): Promise<void> {
  const now = Date.now();
  await execD1(
    matches.map((m) => {
      // The stored snippet marks matches with \u0002…\u0003, as FTS5's snippet() writes them.
      const snippet = m.snippet
        .split(/(\[[^\]]*\])/)
        .filter(Boolean)
        .map((part) =>
          part.startsWith('[')
            ? `char(2) || ${sqlString(part.slice(1, -1))} || char(3)`
            : sqlString(part)
        )
        .join(' || ');
      return `INSERT OR REPLACE INTO channel_matches (user_did, channel_uuid, dedup_key, item_key, source_kind, source_ref, feed_seq, snippet, published_at, matched_at) VALUES (${sqlString(user.did)}, ${sqlString(channelUuid)}, ${sqlString(m.url)}, ${sqlString(m.guid)}, 'feed', ${sqlString(m.feedUrl)}, (SELECT seq FROM feed_items WHERE feed_url = ${sqlString(m.feedUrl)} AND guid = ${sqlString(m.guid)}), ${snippet}, ${m.publishedAt}, ${now})`;
    })
  );
}
