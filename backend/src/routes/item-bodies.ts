import type { Env } from '../types';
import { reportMessage } from '../observability/sentry';
import { log } from '../utils/logger';

/**
 * Out-of-row storage for feed-item bodies over the archive's inline cap.
 *
 * D1 keeps bodies up to MAX_ITEM_CONTENT_BYTES inline in `item_json`, where they
 * ride every timeline page. Anything bigger used to be dropped at ingest and
 * recovered only by an on-open extraction of the web page — which is how a
 * long-form newsletter (thezvi.substack.com: 100–300 KB a post) showed nothing
 * but its one-line <description>. Raising the inline cap can't fix that: the
 * timeline's page budgets are sized against it, and D1's 10 GB ceiling can't
 * absorb unbounded long-form retention.
 *
 * So an over-cap body goes to R2 instead, and the timeline row carries only
 * `contentTruncated` (plus `bodyStored` once the object is known to exist). The
 * reader fetches the body from here when the article is opened, and falls back
 * to extraction only when there's no stored copy (bodies above
 * MAX_STORED_BODY_BYTES, rows ingested before this existed).
 *
 * Keyed by (feed_url, guid) — the archive's own identity — rather than by
 * content hash: an edit overwrites in place, the sanity-cap trim can delete by
 * key, and the client can ask for a body with nothing but what its IndexedDB
 * row already holds (feed URL + guid), including rows cached before this shipped.
 */

// Bodies above this are still dropped (extraction remains the fallback). Far
// above any real post; it only bounds a pathological feed and the size of one
// body response.
export const MAX_STORED_BODY_BYTES = 2 * 1024 * 1024;

// Concurrent R2 calls per ingest request. Workers cap simultaneous open
// connections per invocation at 6; staying under it keeps writes from queueing
// behind each other (and behind the D1 batch).
const R2_CONCURRENCY = 6;

const KEY_PREFIX = 'items/v1/';

// At most one Sentry report per isolate per this long while R2 writes fail. An
// R2 outage fails every ingest request (one per ~15s per proxy), and the issue
// only needs to exist and stay fresh, not count each one. The structured log
// line still goes out every time.
const PUT_FAILURE_REPORT_INTERVAL_MS = 10 * 60 * 1000;
let lastPutFailureReportAt = 0;

export async function itemBodyKey(feedUrl: string, guid: string): Promise<string> {
  // A newline can't appear in a feed URL, so the pair is unambiguous.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${feedUrl}\n${guid}`)
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${KEY_PREFIX}${hex}`;
}

export interface BodyWrite {
  feedUrl: string;
  guid: string;
  content: string;
  contentHash: string;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Write bodies to R2. Returns, per write, whether it landed. A failed put is
 * logged and reported rather than thrown: an R2 outage must not stall the
 * archive (the pusher retries a failed ingest forever), and an item without a
 * stored body degrades to exactly the pre-R2 behaviour — extraction on open.
 */
export async function putItemBodies(env: Env, writes: BodyWrite[]): Promise<boolean[]> {
  const bucket = env.ITEM_BODIES;
  if (!bucket || writes.length === 0) return writes.map(() => false);
  let firstError: unknown;
  const landed = await mapLimited(writes, R2_CONCURRENCY, async (write) => {
    try {
      await bucket.put(await itemBodyKey(write.feedUrl, write.guid), write.content, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
        customMetadata: { contentHash: write.contentHash },
      });
      return true;
    } catch (error) {
      firstError ??= error;
      return false;
    }
  });

  const failed = landed.filter((ok) => !ok).length;
  if (failed > 0) {
    // Silent otherwise: the items still ingest, just without a stored body, so
    // readers quietly fall back to extraction (docs/RUNBOOK.md → item_body_put_failed).
    const message = firstError instanceof Error ? firstError.message : String(firstError);
    log.error('item_body_put_failed', { failed, attempted: writes.length, error: message });
    const now = Date.now();
    if (now - lastPutFailureReportAt >= PUT_FAILURE_REPORT_INTERVAL_MS) {
      lastPutFailureReportAt = now;
      reportMessage('R2 item-body writes failing: long posts fall back to extraction', {
        level: 'warning',
        fingerprint: ['item-body-put-failed'],
        tags: { source: 'ingest', check: 'item-body-put' },
        extra: { failed, attempted: writes.length, error: message },
      });
    }
  }
  return landed;
}

/** Best-effort delete, for rows the sanity-cap trim removed. */
export async function deleteItemBodies(
  env: Env,
  keys: Array<{ feedUrl: string; guid: string }>
): Promise<void> {
  const bucket = env.ITEM_BODIES;
  if (!bucket || keys.length === 0) return;
  try {
    const r2Keys = await Promise.all(keys.map((k) => itemBodyKey(k.feedUrl, k.guid)));
    // R2's bulk delete takes up to 1000 keys per call.
    for (let i = 0; i < r2Keys.length; i += 1000) {
      await bucket.delete(r2Keys.slice(i, i + 1000));
    }
  } catch (error) {
    // An orphaned object costs storage, not correctness.
    console.error('[item-bodies] R2 delete failed:', error);
  }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * GET /api/v2/items/body?feed_url=&guid= (and its guest twin) → `{ content }`.
 *
 * Served as JSON, never as text/html: the body is third-party feed markup, and
 * rendering it on the API origin would hand every feed author script execution
 * there. The reader sanitizes it like any other feed body.
 *
 * No subscription check, deliberately: this is the same public feed content the
 * archive already serves to guests over /api/guest/timeline, and it can only
 * return what the crawler stored — nothing here fetches a caller-named URL.
 */
export async function handleItemBody(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('feed_url');
  const guid = url.searchParams.get('guid');
  if (!feedUrl || !guid) return json({ error: 'feed_url and guid are required' }, 400);

  const bucket = env.ITEM_BODIES;
  if (!bucket) return json({ error: 'Not found' }, 404);

  const [object, row] = await Promise.all([
    bucket.get(await itemBodyKey(feedUrl, guid)),
    env.DB.prepare(
      `SELECT content_hash, json_extract(item_json, '$.bodyStored') AS body_stored
         FROM feed_items WHERE feed_url = ? AND guid = ?`
    )
      .bind(feedUrl, guid)
      .first<{ content_hash: string; body_stored: number | null }>(),
  ]);
  // Serve only the body of the row as it stands now. An edit whose new body
  // never reached R2 (failed put, over the ceiling) leaves the row pointing at
  // nothing while the old object may still sit under the same key; handing that
  // out would show — and the reader would cache — the pre-edit text instead of
  // falling back to extraction.
  const current =
    object != null &&
    row?.body_stored === 1 &&
    object.customMetadata?.contentHash === row.content_hash;
  // A miss is an ordinary answer (small item, pre-R2 row, oversized body), so
  // it's cacheable briefly too — the client memoizes it per session anyway.
  if (!object || !current) {
    return json({ error: 'Not found' }, 404, { 'Cache-Control': 'private, max-age=60' });
  }

  const content = await object.text();
  return json({ content }, 200, {
    // An edit rewrites the object under the same key, so don't let a client hold
    // it for long; the reader caches the body in IndexedDB regardless.
    'Cache-Control': 'private, max-age=3600',
    ETag: object.httpEtag,
  });
}
