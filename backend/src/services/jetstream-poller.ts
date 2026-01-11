import type { Env } from '../types';
import { parseFeed } from './feed-parser';

interface JetstreamEvent {
  did: string;
  time_us: number;
  kind: 'commit' | 'identity' | 'account';
  commit?: {
    rev: string;
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    record?: {
      $type: string;
      feedUrl?: string;
      itemUrl?: string;
      itemTitle?: string;
      itemAuthor?: string;
      itemDescription?: string;
      itemImage?: string;
      itemGuid?: string;
      itemPublishedAt?: string;
      note?: string;
      tags?: string[];
      createdAt?: string;
    };
    cid?: string;
  };
}

export interface PollResult {
  processed: number;
  errors: number;
  cursor?: string;
}

const POLL_TIMEOUT_MS = 30000; // 30 seconds max
const IDLE_TIMEOUT_MS = 2000; // 2 seconds without events = caught up
const CACHE_TTL_SECONDS = 900; // 15 minutes

// Hash URL for cache key (same as feeds.ts)
function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

export async function fetchArticleContent(env: Env, feedUrl: string, itemGuid: string, itemUrl?: string): Promise<string | null> {
  try {
    const urlHash = hashUrl(feedUrl);
    const now = Math.floor(Date.now() / 1000);

    // Check D1 cache first
    const cached = await env.DB.prepare(
      'SELECT content, cached_at FROM feed_cache WHERE url_hash = ?'
    ).bind(urlHash).first<{ content: string; cached_at: number }>();

    const isCacheValid = cached && (now - cached.cached_at) <= CACHE_TTL_SECONDS;

    if (isCacheValid && cached) {
      const parsed = JSON.parse(cached.content) as { items?: { guid: string; url?: string; content?: string; summary?: string }[] };
      if (parsed?.items) {
        // Try matching by GUID first, then by URL
        let article = parsed.items.find(item => item.guid === itemGuid);
        if (!article && itemUrl) {
          article = parsed.items.find(item => item.url === itemUrl);
        }
        if (article) {
          return article.content || article.summary || null;
        }
      }
    }

    // Not in cache or cache stale, fetch from source
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'AT-RSS/1.0 (+https://at-rss.example.com)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch feed ${feedUrl}: ${response.status}`);
      return null;
    }

    const xml = await response.text();
    const parsed = parseFeed(xml, feedUrl);

    // Cache in D1
    await env.DB.prepare(`
      INSERT INTO feed_cache (url_hash, feed_url, content, etag, last_modified, cached_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url_hash) DO UPDATE SET
        content = excluded.content,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        cached_at = excluded.cached_at
    `).bind(
      urlHash,
      feedUrl,
      JSON.stringify(parsed),
      response.headers.get('ETag') || null,
      response.headers.get('Last-Modified') || null,
      now
    ).run();

    // Try matching by GUID first, then by URL
    let article = parsed.items.find(item => item.guid === itemGuid);
    if (!article && itemUrl) {
      article = parsed.items.find(item => item.url === itemUrl);
    }
    return article?.content || article?.summary || null;
  } catch (error) {
    console.error(`Error fetching article content from ${feedUrl}:`, error);
    return null;
  }
}

async function notifyRealtimeHub(env: Env, message: object): Promise<void> {
  try {
    const hubId = env.REALTIME_HUB.idFromName('main');
    const hub = env.REALTIME_HUB.get(hubId);
    await hub.fetch('http://internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch (error) {
    console.error('Failed to notify RealtimeHub:', error);
  }
}

async function processShareEvent(env: Env, event: JetstreamEvent): Promise<void> {
  const { did, commit } = event;
  if (!commit) return;

  const { operation, collection, rkey, record, cid } = commit;

  if (collection !== 'com.at-rss.social.share') return;

  const recordUri = `at://${did}/${collection}/${rkey}`;

  if (operation === 'create' && record && cid) {
    // Fetch article content if feedUrl and itemGuid are available
    let content: string | null = null;
    if (record.feedUrl && record.itemGuid) {
      content = await fetchArticleContent(env, record.feedUrl, record.itemGuid, record.itemUrl);
    }

    // Insert share into D1
    await env.DB.prepare(`
      INSERT OR REPLACE INTO shares
      (author_did, record_uri, record_cid, feed_url, item_url, item_title,
       item_author, item_description, item_image, item_guid, item_published_at,
       note, tags, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      did,
      recordUri,
      cid,
      record.feedUrl || null,
      record.itemUrl,
      record.itemTitle || null,
      record.itemAuthor || null,
      record.itemDescription || null,
      record.itemImage || null,
      record.itemGuid || null,
      record.itemPublishedAt ? new Date(record.itemPublishedAt).getTime() : null,
      record.note || null,
      record.tags ? JSON.stringify(record.tags) : null,
      content,
      record.createdAt ? new Date(record.createdAt).getTime() : Date.now()
    ).run();

    // Ensure user exists
    await env.DB.prepare(`
      INSERT OR IGNORE INTO users (did, handle, pds_url)
      VALUES (?, ?, '')
    `).bind(did, did).run();

    // Always notify RealtimeHub - content may be missing but frontend can fall back to description
    await notifyRealtimeHub(env, {
      type: 'new_share',
      payload: {
        authorDid: did,
        recordUri,
        feedUrl: record.feedUrl,
        itemUrl: record.itemUrl,
        itemTitle: record.itemTitle,
        itemDescription: record.itemDescription,
        itemImage: record.itemImage,
        itemGuid: record.itemGuid,
        itemPublishedAt: record.itemPublishedAt,
        note: record.note,
        content,
        createdAt: record.createdAt,
      },
    });
  } else if (operation === 'delete') {
    await env.DB.prepare(
      'DELETE FROM shares WHERE record_uri = ?'
    ).bind(recordUri).run();
  }
}

export async function pollJetstream(env: Env): Promise<PollResult> {
  // Get cursor from D1
  const cursorResult = await env.DB.prepare(
    'SELECT value FROM sync_state WHERE key = ?'
  ).bind('jetstream_cursor').first<{ value: string }>();

  const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
  wsUrl.searchParams.append('wantedCollections', 'com.at-rss.social.share');

  if (cursorResult?.value) {
    // Subtract 5 seconds (in microseconds) to ensure we catch everything during reconnects
    const cursorWithBuffer = BigInt(cursorResult.value) - BigInt(5_000_000);
    wsUrl.searchParams.set('cursor', cursorWithBuffer.toString());
    console.log(`[Jetstream] Starting poll from cursor ${cursorWithBuffer}`);
  } else {
    console.log('[Jetstream] Starting fresh poll (no cursor)');
  }

  let processed = 0;
  let errors = 0;
  let lastCursor: string | undefined;
  let lastEventTime = Date.now();

  return new Promise((resolve) => {
    const startTime = Date.now();

    // Timeout to ensure we don't run forever
    const pollTimeout = setTimeout(() => {
      console.log(`[Jetstream] Poll timeout after ${POLL_TIMEOUT_MS}ms`);
      cleanup();
    }, POLL_TIMEOUT_MS);

    // Check for idle (caught up)
    const idleCheck = setInterval(() => {
      if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) {
        console.log(`[Jetstream] Caught up (idle for ${IDLE_TIMEOUT_MS}ms)`);
        cleanup();
      }
    }, 500);

    let ws: WebSocket | null = null;

    const cleanup = async () => {
      clearTimeout(pollTimeout);
      clearInterval(idleCheck);

      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close errors
        }
        ws = null;
      }

      // Save final cursor
      if (lastCursor) {
        await env.DB.prepare(
          'INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())'
        ).bind('jetstream_cursor', lastCursor).run();
      }

      const duration = Date.now() - startTime;
      console.log(`[Jetstream] Poll complete: ${processed} processed, ${errors} errors, ${duration}ms`);

      resolve({ processed, errors, cursor: lastCursor });
    };

    try {
      ws = new WebSocket(wsUrl.toString());

      ws.addEventListener('open', () => {
        console.log('[Jetstream] Connected');
        lastEventTime = Date.now();
      });

      ws.addEventListener('message', async (event) => {
        lastEventTime = Date.now();

        try {
          const data = JSON.parse(event.data as string) as JetstreamEvent;

          // Update cursor
          lastCursor = data.time_us.toString();

          // Process the event
          if (data.kind === 'commit' && data.commit?.collection === 'com.at-rss.social.share') {
            await processShareEvent(env, data);
            processed++;
          }
        } catch (error) {
          console.error('[Jetstream] Error processing event:', error);
          errors++;
        }
      });

      ws.addEventListener('close', () => {
        console.log('[Jetstream] Disconnected');
        cleanup();
      });

      ws.addEventListener('error', (error) => {
        console.error('[Jetstream] WebSocket error:', error);
        cleanup();
      });
    } catch (error) {
      console.error('[Jetstream] Failed to connect:', error);
      cleanup();
    }
  });
}
