import type { Env } from '../types';
import { fetchArticleContent } from '../services/article-content';

// Jetstream event types
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
      subject?: string; // For follow records
    };
    cid?: string;
  };
}

interface ProfileInfo {
  handle: string;
  displayName?: string;
  avatar?: string;
}

interface PollStats {
  shares: { processed: number; errors: number };
  follows: { processed: number; errors: number };
  inappFollows: { processed: number; errors: number };
  duration: number;
  lastPollAt: number;
}

// Constants
const POLL_TIMEOUT_MS = 8000; // 8 seconds per stream
const IDLE_TIMEOUT_MS = 2000; // 2 seconds without events = caught up
const ALARM_INTERVAL_MS = 60000; // 60 seconds between polls
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const MAX_WANTED_DIDS = 100;

export class JetstreamPoller implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/start') {
      // Ensure polling is running
      const alarmTime = await this.state.storage.getAlarm();
      if (!alarmTime) {
        // Start immediately and schedule next poll
        await this.state.storage.setAlarm(Date.now() + 100);
        return new Response(JSON.stringify({ status: 'started' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ status: 'already_running', nextPoll: alarmTime }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/status') {
      const [sharesCursor, followsCursor, inappFollowsCursor, lastStats, alarmTime] = await Promise.all([
        this.state.storage.get<string>('cursor_shares'),
        this.state.storage.get<string>('cursor_follows'),
        this.state.storage.get<string>('cursor_inapp_follows'),
        this.state.storage.get<PollStats>('last_stats'),
        this.state.storage.getAlarm(),
      ]);

      return new Response(JSON.stringify({
        cursors: {
          shares: sharesCursor,
          follows: followsCursor,
          inappFollows: inappFollowsCursor,
        },
        lastStats,
        nextPoll: alarmTime,
        isRunning: !!alarmTime,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const startTime = Date.now();
    console.log('[JetstreamPoller] Starting poll cycle');

    const stats: PollStats = {
      shares: { processed: 0, errors: 0 },
      follows: { processed: 0, errors: 0 },
      inappFollows: { processed: 0, errors: 0 },
      duration: 0,
      lastPollAt: startTime,
    };

    try {
      // Poll streams sequentially to reduce peak CPU usage
      // 1. Shares (app.skyreader.social.share)
      console.log('[JetstreamPoller] Polling shares stream');
      const sharesResult = await this.pollSharesStream();
      stats.shares = sharesResult;

      // 2. Follows (app.bsky.graph.follow)
      console.log('[JetstreamPoller] Polling follows stream');
      const followsResult = await this.pollFollowsStream();
      stats.follows = followsResult;

      // 3. In-app follows (app.skyreader.social.follow)
      console.log('[JetstreamPoller] Polling in-app follows stream');
      const inappFollowsResult = await this.pollInappFollowsStream();
      stats.inappFollows = inappFollowsResult;

    } catch (error) {
      console.error('[JetstreamPoller] Error during poll cycle:', error);
    }

    stats.duration = Date.now() - startTime;

    // Save stats (best effort - don't let this crash the alarm)
    try {
      await this.state.storage.put('last_stats', stats);
    } catch (error) {
      console.error('[JetstreamPoller] Error saving stats:', error);
    }

    console.log(`[JetstreamPoller] Poll complete: shares=${stats.shares.processed}/${stats.shares.errors}, ` +
      `follows=${stats.follows.processed}/${stats.follows.errors}, ` +
      `inappFollows=${stats.inappFollows.processed}/${stats.inappFollows.errors}, ` +
      `duration=${stats.duration}ms`);

    // Schedule next poll - CRITICAL: always attempt this to keep poller alive
    try {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    } catch (error) {
      console.error('[JetstreamPoller] CRITICAL: Error scheduling next alarm:', error);
    }
  }

  // --- Shares Stream ---
  private async pollSharesStream(): Promise<{ processed: number; errors: number }> {
    const cursor = await this.state.storage.get<string>('cursor_shares');

    const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
    wsUrl.searchParams.append('wantedCollections', 'app.skyreader.social.share');

    let lastCursor: string;
    if (cursor) {
      wsUrl.searchParams.set('cursor', cursor);
      lastCursor = cursor;
    } else {
      lastCursor = (Date.now() * 1000).toString();
    }

    return new Promise((resolve) => {
      let processed = 0;
      let errors = 0;
      let lastEventTime = Date.now();
      let cleanedUp = false;

      const cleanupWithCatch = () => cleanup().catch(e => console.error('[JetstreamPoller] shares cleanup error:', e));

      const pollTimeout = setTimeout(cleanupWithCatch, POLL_TIMEOUT_MS);
      const idleCheck = setInterval(() => {
        if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) {
          cleanupWithCatch();
        }
      }, 500);

      let ws: WebSocket | null = null;

      const cleanup = async () => {
        if (cleanedUp) return;
        cleanedUp = true;

        clearTimeout(pollTimeout);
        clearInterval(idleCheck);

        if (ws) {
          try { ws.close(); } catch { /* ignore */ }
          ws = null;
        }

        await this.state.storage.put('cursor_shares', lastCursor);
        resolve({ processed, errors });
      };

      try {
        ws = new WebSocket(wsUrl.toString());

        ws.addEventListener('open', () => {
          lastEventTime = Date.now();
        });

        ws.addEventListener('message', async (event) => {
          try {
            const data = JSON.parse(event.data as string) as JetstreamEvent;

            if (data.kind === 'commit') {
              lastEventTime = Date.now();
            }

            if (data.time_us) {
              lastCursor = data.time_us.toString();
            }

            if (data.kind === 'commit' && data.commit?.collection === 'app.skyreader.social.share') {
              await this.processShareEvent(data);
              processed++;
            }
          } catch (error) {
            console.error('[JetstreamPoller] Error processing share event:', error);
            errors++;
          }
        });

        ws.addEventListener('close', cleanupWithCatch);
        ws.addEventListener('error', cleanupWithCatch);
      } catch {
        cleanupWithCatch();
      }
    });
  }

  private async processShareEvent(event: JetstreamEvent): Promise<void> {
    const { did, commit } = event;
    if (!commit) return;

    const { operation, collection, rkey, record, cid } = commit;
    if (collection !== 'app.skyreader.social.share') return;

    const recordUri = `at://${did}/${collection}/${rkey}`;

    if (operation === 'create' && record && cid) {
      // Fetch article content if available
      let content: string | null = null;
      if (record.feedUrl && record.itemGuid) {
        content = await fetchArticleContent(this.env, record.feedUrl, record.itemGuid, record.itemUrl);
      }

      // Insert share into D1
      await this.env.DB.prepare(`
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
      await this.env.DB.prepare(`
        INSERT OR IGNORE INTO users (did, handle, pds_url)
        VALUES (?, ?, '')
      `).bind(did, did).run();

      // Notify RealtimeHub
      await this.notifyRealtimeHub({
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
      await this.env.DB.prepare(
        'DELETE FROM shares WHERE record_uri = ?'
      ).bind(recordUri).run();
    }
  }

  // --- Follows Stream ---
  private async pollFollowsStream(): Promise<{ processed: number; errors: number }> {
    // Get active user DIDs for filtering
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SECONDS;
    const activeUsersResult = await this.env.DB.prepare(`
      SELECT did FROM users
      WHERE pds_url != ''
        AND pds_url IS NOT NULL
        AND last_active_at > ?
      LIMIT ?
    `).bind(sevenDaysAgo, MAX_WANTED_DIDS).all<{ did: string }>();

    const activeUsers = activeUsersResult.results.map(r => r.did);

    if (activeUsers.length === 0) {
      console.log('[JetstreamPoller] No active users to poll follows for');
      return { processed: 0, errors: 0 };
    }

    const cursor = await this.state.storage.get<string>('cursor_follows');

    const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
    wsUrl.searchParams.append('wantedCollections', 'app.bsky.graph.follow');
    for (const did of activeUsers) {
      wsUrl.searchParams.append('wantedDids', did);
    }

    let lastCursor: string;
    if (cursor) {
      wsUrl.searchParams.set('cursor', cursor);
      lastCursor = cursor;
    } else {
      lastCursor = (Date.now() * 1000).toString();
    }

    return new Promise((resolve) => {
      let processed = 0;
      let errors = 0;
      let lastEventTime = Date.now();
      let cleanedUp = false;

      const cleanupWithCatch = () => cleanup().catch(e => console.error('[JetstreamPoller] follows cleanup error:', e));

      const pollTimeout = setTimeout(cleanupWithCatch, POLL_TIMEOUT_MS);
      const idleCheck = setInterval(() => {
        if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) {
          cleanupWithCatch();
        }
      }, 500);

      let ws: WebSocket | null = null;

      const cleanup = async () => {
        if (cleanedUp) return;
        cleanedUp = true;

        clearTimeout(pollTimeout);
        clearInterval(idleCheck);

        if (ws) {
          try { ws.close(); } catch { /* ignore */ }
          ws = null;
        }

        await this.state.storage.put('cursor_follows', lastCursor);
        resolve({ processed, errors });
      };

      try {
        ws = new WebSocket(wsUrl.toString());

        ws.addEventListener('open', () => {
          lastEventTime = Date.now();
        });

        ws.addEventListener('message', async (event) => {
          lastEventTime = Date.now();
          try {
            const data = JSON.parse(event.data as string) as JetstreamEvent;
            lastCursor = data.time_us.toString();

            if (data.kind === 'commit' && data.commit?.collection === 'app.bsky.graph.follow') {
              await this.processFollowEvent(data);
              processed++;
            }
          } catch (error) {
            console.error('[JetstreamPoller] Error processing follow event:', error);
            errors++;
          }
        });

        ws.addEventListener('close', cleanupWithCatch);
        ws.addEventListener('error', cleanupWithCatch);
      } catch {
        cleanupWithCatch();
      }
    });
  }

  private async processFollowEvent(event: JetstreamEvent): Promise<void> {
    const { did: followerDid, commit } = event;
    if (!commit || commit.collection !== 'app.bsky.graph.follow') return;

    const { operation, rkey, record } = commit;

    if (operation === 'create' && record) {
      const followingDid = record.subject!;

      await this.env.DB.prepare(`
        INSERT OR REPLACE INTO follows_cache (follower_did, following_did, rkey, created_at)
        VALUES (?, ?, ?, unixepoch())
      `).bind(followerDid, followingDid, rkey).run();

      // Fetch profile info
      const profile = await this.fetchProfileInfo(followingDid);

      await this.env.DB.prepare(`
        INSERT INTO users (did, handle, display_name, avatar_url, pds_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', unixepoch(), unixepoch())
        ON CONFLICT(did) DO UPDATE SET
          handle = CASE WHEN excluded.handle != excluded.did THEN excluded.handle ELSE users.handle END,
          display_name = COALESCE(excluded.display_name, users.display_name),
          avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
          updated_at = unixepoch()
      `).bind(
        followingDid,
        profile?.handle || followingDid,
        profile?.displayName || null,
        profile?.avatar || null
      ).run();

      console.log(`[JetstreamPoller] ${followerDid} followed ${profile?.handle || followingDid}`);

    } else if (operation === 'delete') {
      const result = await this.env.DB.prepare(`
        DELETE FROM follows_cache
        WHERE follower_did = ? AND rkey = ?
      `).bind(followerDid, rkey).run();

      if (result.meta.changes > 0) {
        console.log(`[JetstreamPoller] ${followerDid} unfollowed (rkey: ${rkey})`);
      }
    }
  }

  // --- In-app Follows Stream ---
  private async pollInappFollowsStream(): Promise<{ processed: number; errors: number }> {
    const cursor = await this.state.storage.get<string>('cursor_inapp_follows');

    const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
    wsUrl.searchParams.append('wantedCollections', 'app.skyreader.social.follow');

    let lastCursor: string;
    if (cursor) {
      wsUrl.searchParams.set('cursor', cursor);
      lastCursor = cursor;
    } else {
      lastCursor = (Date.now() * 1000).toString();
    }

    return new Promise((resolve) => {
      let processed = 0;
      let errors = 0;
      let lastEventTime = Date.now();
      let cleanedUp = false;

      const cleanupWithCatch = () => cleanup().catch(e => console.error('[JetstreamPoller] inapp follows cleanup error:', e));

      const pollTimeout = setTimeout(cleanupWithCatch, POLL_TIMEOUT_MS);
      const idleCheck = setInterval(() => {
        if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) {
          cleanupWithCatch();
        }
      }, 500);

      let ws: WebSocket | null = null;

      const cleanup = async () => {
        if (cleanedUp) return;
        cleanedUp = true;

        clearTimeout(pollTimeout);
        clearInterval(idleCheck);

        if (ws) {
          try { ws.close(); } catch { /* ignore */ }
          ws = null;
        }

        await this.state.storage.put('cursor_inapp_follows', lastCursor);
        resolve({ processed, errors });
      };

      try {
        ws = new WebSocket(wsUrl.toString());

        ws.addEventListener('open', () => {
          lastEventTime = Date.now();
        });

        ws.addEventListener('message', async (event) => {
          try {
            const data = JSON.parse(event.data as string) as JetstreamEvent;

            if (data.kind === 'commit') {
              lastEventTime = Date.now();
            }

            if (data.time_us) {
              lastCursor = data.time_us.toString();
            }

            if (data.kind === 'commit' && data.commit?.collection === 'app.skyreader.social.follow') {
              await this.processInappFollowEvent(data);
              processed++;
            }
          } catch (error) {
            console.error('[JetstreamPoller] Error processing in-app follow event:', error);
            errors++;
          }
        });

        ws.addEventListener('close', cleanupWithCatch);
        ws.addEventListener('error', cleanupWithCatch);
      } catch {
        cleanupWithCatch();
      }
    });
  }

  private async processInappFollowEvent(event: JetstreamEvent): Promise<void> {
    const { did: followerDid, commit } = event;
    if (!commit || commit.collection !== 'app.skyreader.social.follow') return;

    const { operation, rkey, record } = commit;

    if (operation === 'create' && record) {
      const followingDid = record.subject!;

      await this.env.DB.prepare(`
        INSERT OR REPLACE INTO inapp_follows (follower_did, following_did, rkey, record_uri, created_at)
        VALUES (?, ?, ?, ?, unixepoch())
      `).bind(
        followerDid,
        followingDid,
        rkey,
        `at://${followerDid}/app.skyreader.social.follow/${rkey}`
      ).run();

      // Fetch profile info
      const profile = await this.fetchProfileInfo(followingDid);

      await this.env.DB.prepare(`
        INSERT INTO users (did, handle, display_name, avatar_url, pds_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', unixepoch(), unixepoch())
        ON CONFLICT(did) DO UPDATE SET
          handle = CASE WHEN excluded.handle != excluded.did THEN excluded.handle ELSE users.handle END,
          display_name = COALESCE(excluded.display_name, users.display_name),
          avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
          updated_at = unixepoch()
      `).bind(
        followingDid,
        profile?.handle || followingDid,
        profile?.displayName || null,
        profile?.avatar || null
      ).run();

      console.log(`[JetstreamPoller] ${followerDid} in-app followed ${profile?.handle || followingDid}`);

    } else if (operation === 'delete') {
      const result = await this.env.DB.prepare(`
        DELETE FROM inapp_follows
        WHERE follower_did = ? AND rkey = ?
      `).bind(followerDid, rkey).run();

      if (result.meta.changes > 0) {
        console.log(`[JetstreamPoller] ${followerDid} in-app unfollowed (rkey: ${rkey})`);
      }
    }
  }

  // --- Helper Methods ---
  private async fetchProfileInfo(did: string): Promise<ProfileInfo | null> {
    try {
      const response = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
        {
          headers: { 'Accept': 'application/json' },
        }
      );

      if (!response.ok) return null;

      const data = await response.json() as {
        handle: string;
        displayName?: string;
        avatar?: string;
      };

      return {
        handle: data.handle,
        displayName: data.displayName,
        avatar: data.avatar,
      };
    } catch {
      return null;
    }
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
      console.error('[JetstreamPoller] Failed to notify RealtimeHub:', error);
    }
  }
}
