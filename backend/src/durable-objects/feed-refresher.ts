import type { Env, FeedItem } from '../types';
import { parseFeed } from '../services/feed-parser';
import { storeItems } from '../routes/feeds';

// Constants
const BATCH_SIZE = 1; // Process one feed at a time to avoid CPU spikes
const MAX_FEEDS_PER_CYCLE = 50;
const DELAY_BETWEEN_BATCHES_MS = 2000;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const MAX_ERROR_COUNT = 10;
const MAX_CONTENT_SIZE = 500000; // 500KB max for cached content
const MAX_FEED_SIZE_BYTES = 2 * 1024 * 1024; // 2MB limit to prevent CPU exhaustion

interface FeedToFetch {
  feed_url: string;
  subscriber_count: number;
}

interface CycleState {
  feeds: FeedToFetch[];
  currentIndex: number;
  fetched: number;
  skipped: number;
  errors: number;
  startedAt: number;
}

interface RefreshStats {
  fetched: number;
  skipped: number;
  errors: number;
  duration: number;
  lastCycleAt: number;
}

function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

export class FeedRefresher implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/trigger') {
      // Start a new refresh cycle
      const cycleState = await this.state.storage.get<CycleState>('cycle_state');

      if (cycleState && cycleState.currentIndex < cycleState.feeds.length) {
        // Cycle already in progress
        return new Response(JSON.stringify({
          status: 'in_progress',
          progress: `${cycleState.currentIndex}/${cycleState.feeds.length}`,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Start new cycle
      const feeds = await this.getFeedsToRefresh();

      if (feeds.length === 0) {
        return new Response(JSON.stringify({
          status: 'no_feeds',
          message: 'No feeds need refreshing',
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const newCycleState: CycleState = {
        feeds,
        currentIndex: 0,
        fetched: 0,
        skipped: 0,
        errors: 0,
        startedAt: Date.now(),
      };

      await this.state.storage.put('cycle_state', newCycleState);
      // Start processing immediately
      await this.state.storage.setAlarm(Date.now() + 100);

      return new Response(JSON.stringify({
        status: 'started',
        feedCount: feeds.length,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/status') {
      const [cycleState, lastStats, alarmTime] = await Promise.all([
        this.state.storage.get<CycleState>('cycle_state'),
        this.state.storage.get<RefreshStats>('last_stats'),
        this.state.storage.getAlarm(),
      ]);

      return new Response(JSON.stringify({
        cycleState: cycleState ? {
          totalFeeds: cycleState.feeds.length,
          currentIndex: cycleState.currentIndex,
          fetched: cycleState.fetched,
          skipped: cycleState.skipped,
          errors: cycleState.errors,
          startedAt: cycleState.startedAt,
        } : null,
        lastStats,
        nextAlarm: alarmTime,
        isRunning: !!alarmTime,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const cycleState = await this.state.storage.get<CycleState>('cycle_state');

    if (!cycleState || cycleState.currentIndex >= cycleState.feeds.length) {
      // Cycle complete or no cycle
      console.log('[FeedRefresher] No active cycle');
      return;
    }

    // Process a batch of feeds
    const batch = cycleState.feeds.slice(
      cycleState.currentIndex,
      cycleState.currentIndex + BATCH_SIZE
    );

    console.log(`[FeedRefresher] Processing batch ${cycleState.currentIndex / BATCH_SIZE + 1}: ` +
      `feeds ${cycleState.currentIndex + 1}-${cycleState.currentIndex + batch.length} of ${cycleState.feeds.length}`);

    const results = await Promise.allSettled(
      batch.map(feed => this.fetchAndCacheFeed(feed.feed_url, feed.subscriber_count))
    );

    let batchFetched = 0;
    let batchSkipped = 0;
    let batchErrors = 0;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.status === 'fetched') {
          batchFetched++;
        } else {
          batchSkipped++;
        }
      } else {
        batchErrors++;
        console.error('[FeedRefresher] Feed fetch failed:', result.reason);
      }
    }

    // Update cycle state
    cycleState.currentIndex += batch.length;
    cycleState.fetched += batchFetched;
    cycleState.skipped += batchSkipped;
    cycleState.errors += batchErrors;

    if (cycleState.currentIndex >= cycleState.feeds.length) {
      // Cycle complete
      const stats: RefreshStats = {
        fetched: cycleState.fetched,
        skipped: cycleState.skipped,
        errors: cycleState.errors,
        duration: Date.now() - cycleState.startedAt,
        lastCycleAt: Date.now(),
      };

      await this.state.storage.put('last_stats', stats);
      await this.state.storage.delete('cycle_state');

      console.log(`[FeedRefresher] Cycle complete: ${stats.fetched} fetched, ` +
        `${stats.skipped} skipped, ${stats.errors} errors, ${stats.duration}ms`);
    } else {
      // Save state and schedule next batch
      await this.state.storage.put('cycle_state', cycleState);
      await this.state.storage.setAlarm(Date.now() + DELAY_BETWEEN_BATCHES_MS);

      console.log(`[FeedRefresher] Batch done: ${batchFetched}/${batchSkipped}/${batchErrors}, ` +
        `next batch in ${DELAY_BETWEEN_BATCHES_MS}ms`);
    }
  }

  private async getFeedsToRefresh(): Promise<FeedToFetch[]> {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SECONDS;

    const result = await this.env.DB.prepare(`
      SELECT DISTINCT sc.feed_url, COUNT(DISTINCT sc.user_did) as subscriber_count
      FROM subscriptions_cache sc
      INNER JOIN users u ON sc.user_did = u.did
      LEFT JOIN feed_metadata fm ON sc.feed_url = fm.feed_url
      WHERE u.last_active_at > ?
      GROUP BY sc.feed_url
      ORDER BY COALESCE(fm.last_scheduled_fetch_at, 0) ASC, subscriber_count DESC
      LIMIT ?
    `).bind(sevenDaysAgo, MAX_FEEDS_PER_CYCLE).all<FeedToFetch>();

    console.log(`[FeedRefresher] Found ${result.results.length} feeds to refresh`);
    return result.results;
  }

  private async fetchAndCacheFeed(
    feedUrl: string,
    subscriberCount: number
  ): Promise<{ status: 'fetched' | 'skipped' | 'not_modified' }> {
    const urlHash = hashUrl(feedUrl);
    const now = Math.floor(Date.now() / 1000);

    // Check if feed has too many errors
    const errorCheck = await this.env.DB.prepare(
      'SELECT error_count FROM feed_metadata WHERE feed_url = ?'
    ).bind(feedUrl).first<{ error_count: number }>();

    if (errorCheck && errorCheck.error_count >= MAX_ERROR_COUNT) {
      console.log(`[FeedRefresher] Skipping ${feedUrl}: too many errors (${errorCheck.error_count})`);
      return { status: 'skipped' };
    }

    // Get existing metadata for conditional request
    const meta = await this.env.DB.prepare(
      'SELECT etag, last_modified FROM feed_cache WHERE url_hash = ?'
    ).bind(urlHash).first<{ etag: string | null; last_modified: string | null }>();

    const headers: HeadersInit = {
      'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    };

    if (meta?.etag) {
      headers['If-None-Match'] = meta.etag;
    }
    if (meta?.last_modified) {
      headers['If-Modified-Since'] = meta.last_modified;
    }

    const response = await fetch(feedUrl, {
      headers,
      cf: { cacheTtl: 0 },
    });

    // Not modified
    if (response.status === 304) {
      await this.updateScheduledFetchTime(feedUrl, subscriberCount);
      await this.env.DB.prepare(
        'UPDATE feed_cache SET cached_at = ? WHERE url_hash = ?'
      ).bind(now, urlHash).run();
      return { status: 'not_modified' };
    }

    if (!response.ok) {
      await this.recordFetchError(feedUrl, `HTTP ${response.status}`);
      throw new Error(`Failed to fetch ${feedUrl}: ${response.status}`);
    }

    // Check content size before reading body to prevent CPU exhaustion on large feeds
    const contentLength = response.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength, 10) > MAX_FEED_SIZE_BYTES) {
      await this.recordFetchError(feedUrl, 'Feed too large');
      console.log(`[FeedRefresher] Skipping ${feedUrl}: content too large (${contentLength} bytes)`);
      return { status: 'skipped' };
    }

    const xml = await response.text();

    let parsed;
    try {
      parsed = parseFeed(xml, feedUrl);
    } catch (parseError) {
      const errorMsg = parseError instanceof Error ? parseError.message : 'Parse error';
      await this.recordFetchError(feedUrl, errorMsg);
      throw parseError;
    }

    // Store individual items
    const { newCount, isInitialImport } = await storeItems(this.env, feedUrl, parsed.items);

    // Cache in D1 (with size limit)
    let contentToCache = JSON.stringify(parsed);

    if (contentToCache.length > MAX_CONTENT_SIZE) {
      const truncatedParsed = {
        ...parsed,
        items: parsed.items.slice(0, Math.floor(parsed.items.length / 2)),
      };
      contentToCache = JSON.stringify(truncatedParsed);
      if (contentToCache.length > MAX_CONTENT_SIZE) {
        contentToCache = JSON.stringify({ ...parsed, items: [] });
      }
    }

    await this.env.DB.prepare(`
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
      contentToCache,
      response.headers.get('ETag') || null,
      response.headers.get('Last-Modified') || null,
      now
    ).run();

    // Update feed metadata
    await this.env.DB.prepare(`
      INSERT INTO feed_metadata (feed_url, title, site_url, description, last_fetched_at, last_scheduled_fetch_at, subscriber_count, etag, last_modified, fetch_error, error_count)
      VALUES (?, ?, ?, ?, unixepoch(), unixepoch(), ?, ?, ?, NULL, 0)
      ON CONFLICT(feed_url) DO UPDATE SET
        title = excluded.title,
        site_url = excluded.site_url,
        description = excluded.description,
        last_fetched_at = unixepoch(),
        last_scheduled_fetch_at = unixepoch(),
        subscriber_count = excluded.subscriber_count,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        fetch_error = NULL,
        error_count = 0
    `).bind(
      feedUrl,
      parsed.title,
      parsed.siteUrl || null,
      parsed.description || null,
      subscriberCount,
      response.headers.get('ETag') || null,
      response.headers.get('Last-Modified') || null
    ).run();

    // Notify RealtimeHub if there are new articles
    if (newCount > 0) {
      await this.notifyRealtimeHub({
        type: 'new_articles',
        payload: {
          feedUrl,
          feedTitle: parsed.title,
          newCount,
          timestamp: Date.now(),
        },
      });
    }

    // Notify feed_ready on initial import
    if (isInitialImport) {
      await this.notifyRealtimeHub({
        type: 'feed_ready',
        payload: {
          feedUrl,
          feedTitle: parsed.title,
          itemCount: parsed.items.length,
          timestamp: Date.now(),
        },
      });
    }

    console.log(`[FeedRefresher] ${feedUrl}: fetched, ${newCount} new items`);
    return { status: 'fetched' };
  }

  private async updateScheduledFetchTime(feedUrl: string, subscriberCount: number): Promise<void> {
    await this.env.DB.prepare(`
      UPDATE feed_metadata
      SET last_scheduled_fetch_at = unixepoch(),
          subscriber_count = ?
      WHERE feed_url = ?
    `).bind(subscriberCount, feedUrl).run();
  }

  private async recordFetchError(feedUrl: string, error: string): Promise<void> {
    await this.env.DB.prepare(`
      INSERT INTO feed_metadata (feed_url, fetch_error, error_count, last_scheduled_fetch_at)
      VALUES (?, ?, 1, unixepoch())
      ON CONFLICT(feed_url) DO UPDATE SET
        fetch_error = excluded.fetch_error,
        error_count = error_count + 1,
        last_scheduled_fetch_at = unixepoch()
    `).bind(feedUrl, error).run();
  }

  private async notifyRealtimeHub(message: object): Promise<void> {
    try {
      const hubId = this.env.REALTIME_HUB.idFromName('main');
      const hub = this.env.REALTIME_HUB.get(hubId);
      await hub.fetch('http://internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
    } catch (error) {
      console.error('[FeedRefresher] Failed to notify RealtimeHub:', error);
    }
  }
}
