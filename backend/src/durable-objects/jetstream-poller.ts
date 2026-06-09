import type { Env } from '../types';
import { resolveCanonicalUrl } from '../utils/canonical-url';

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
      // For site.standard.document records: structured content object
      content?: { $type: string; pages?: unknown[] };
      tags?: string[];
      createdAt?: string;
      subject?: string; // For follow records
      title?: string; // For subscription records
      category?: string; // For subscription records
      // For site.standard.document records
      site?: string;
      publishedAt?: string;
      path?: string;
      description?: string;
      coverImage?: { ref: { $link: string }; mimeType: string };
      textContent?: string;
      bskyPostRef?: { uri: string; cid: string };
      updatedAt?: string;
      // For saved records
      url?: string;
      savedAt?: string;
      contentType?: string;
      domain?: string;
      image?: string;
      wordCount?: number;
    };
    cid?: string;
  };
}

interface PollStats {
  subscriptions: { processed: number; errors: number };
  documents: { processed: number; errors: number };
  saved: { processed: number; errors: number };
  duration: number;
  lastPollAt: number;
}

// Constants
const POLL_TIMEOUT_MS = 8000; // 8 seconds per stream
const IDLE_TIMEOUT_MS = 2000; // 2 seconds without events = caught up
const ALARM_INTERVAL_MS = 60000; // 60 seconds between polls

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
      // Check both scheduled alarm AND recent activity to avoid race conditions
      // (getAlarm() returns null while an alarm is currently running)
      const [alarmTime, lastAlarmStart] = await Promise.all([
        this.state.storage.getAlarm(),
        this.state.storage.get<number>('last_alarm_start'),
      ]);

      const recentlyActive = lastAlarmStart && Date.now() - lastAlarmStart < 120000; // 2 minutes

      if (!alarmTime && !recentlyActive) {
        // No alarm scheduled and none ran recently - start fresh
        await this.state.storage.setAlarm(Date.now() + 100);
        return new Response(JSON.stringify({ status: 'started' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          status: alarmTime ? 'scheduled' : 'recently_active',
          nextPoll: alarmTime,
          lastAlarmStart,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    if (url.pathname === '/status') {
      const [subscriptionsCursor, documentsCursor, savedCursor, lastStats, alarmTime] =
        await Promise.all([
          this.state.storage.get<string>('cursor_subscriptions'),
          this.state.storage.get<string>('cursor_documents'),
          this.state.storage.get<string>('cursor_saved'),
          this.state.storage.get<PollStats>('last_stats'),
          this.state.storage.getAlarm(),
        ]);

      return new Response(
        JSON.stringify({
          cursors: {
            subscriptions: subscriptionsCursor,
            documents: documentsCursor,
            saved: savedCursor,
          },
          lastStats,
          nextPoll: alarmTime,
          isRunning: !!alarmTime,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    // Record when this alarm started to prevent race conditions with /start
    // (cron calls /start every minute, but getAlarm() returns null while running)
    await this.state.storage.put('last_alarm_start', Date.now());

    // Top-level try-catch to ensure we NEVER crash the alarm handler
    // The finally block ensures we always schedule the next alarm
    try {
      const startTime = Date.now();
      console.log('[JetstreamPoller] Starting poll cycle');

      const stats: PollStats = {
        subscriptions: { processed: 0, errors: 0 },
        documents: { processed: 0, errors: 0 },
        saved: { processed: 0, errors: 0 },
        duration: 0,
        lastPollAt: startTime,
      };

      try {
        // Poll streams sequentially to reduce peak CPU usage
        // 1. Subscriptions (app.skyreader.feed.subscription) - global watch, filter by sync-enabled
        console.log('[JetstreamPoller] Polling subscriptions stream');
        const subscriptionsResult = await this.pollSubscriptionsStream();
        stats.subscriptions = subscriptionsResult;

        // 2. Documents (site.standard.document) - filter to followed users
        console.log('[JetstreamPoller] Polling documents stream');
        const documentsResult = await this.pollDocumentsStream();
        stats.documents = documentsResult;

        // 3. Saved (app.skyreader.feed.saved) - global watch, filter by registered users
        console.log('[JetstreamPoller] Polling saved stream');
        const savedResult = await this.pollSavedStream();
        stats.saved = savedResult;
      } catch (error) {
        console.error('[JetstreamPoller] Error during poll cycle:', error);
      }

      stats.duration = Date.now() - startTime;

      // Save stats (best effort)
      try {
        await this.state.storage.put('last_stats', stats);
      } catch (error) {
        console.error('[JetstreamPoller] Error saving stats:', error);
      }

      console.log(
        `[JetstreamPoller] Poll complete: ` +
          `subscriptions=${stats.subscriptions.processed}/${stats.subscriptions.errors}, ` +
          `documents=${stats.documents.processed}/${stats.documents.errors}, ` +
          `saved=${stats.saved.processed}/${stats.saved.errors}, ` +
          `duration=${stats.duration}ms`
      );
    } catch (error) {
      // Catch-all for any unexpected errors
      console.error('[JetstreamPoller] UNEXPECTED ERROR in alarm handler:', error);
    } finally {
      // ALWAYS schedule next poll - this runs even if an error occurred above
      try {
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      } catch (error) {
        console.error('[JetstreamPoller] CRITICAL: Error scheduling next alarm:', error);
      }
    }
  }

  // --- Subscriptions Stream ---
  // Watches globally (all app.skyreader.feed.subscription events) but only
  // processes events for users who have sync enabled in Skyreader
  private async pollSubscriptionsStream(): Promise<{
    processed: number;
    errors: number;
  }> {
    // Fetch sync-enabled DIDs upfront to check before inserting
    const syncEnabledDids = await this.getSyncEnabledDidsSet();

    const cursor = await this.state.storage.get<string>('cursor_subscriptions');

    const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
    wsUrl.searchParams.append('wantedCollections', 'app.skyreader.feed.subscription');

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

      const cleanupWithCatch = () =>
        cleanup().catch((e) => console.error('[JetstreamPoller] subscriptions cleanup error:', e));

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
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          ws = null;
        }

        await this.state.storage.put('cursor_subscriptions', lastCursor);
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

            if (
              data.kind === 'commit' &&
              data.commit?.collection === 'app.skyreader.feed.subscription'
            ) {
              const wasProcessed = await this.processSubscriptionEvent(data, syncEnabledDids);
              if (wasProcessed) processed++;
            }
          } catch (error) {
            console.error('[JetstreamPoller] Error processing subscription event:', error);
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

  private async processSubscriptionEvent(
    event: JetstreamEvent,
    syncEnabledDids: Set<string>
  ): Promise<boolean> {
    const { did, commit } = event;
    if (!commit || commit.collection !== 'app.skyreader.feed.subscription') return false;

    // Only process events for users who have sync enabled in Skyreader
    if (!syncEnabledDids.has(did)) {
      return false;
    }

    const { operation, rkey, record } = commit;
    const recordUri = `at://${did}/app.skyreader.feed.subscription/${rkey}`;

    if ((operation === 'create' || operation === 'update') && record) {
      // Extract fields from the record (cast to access AT Proto fields)
      const recAny = record as Record<string, unknown>;
      const sourceType = (recAny.sourceType as string) || null;
      const subjectDid = (recAny.subjectDid as string) || null;
      const customTitle = (recAny.customTitle as string) || null;
      const customIconUrl = (recAny.customIconUrl as string) || null;
      const category = (recAny.category as string) || null;

      try {
        await this.env.DB.prepare(
          `
					INSERT OR REPLACE INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, source_type, subject_did, custom_title, custom_icon_url, category)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`
        )
          .bind(
            did,
            recordUri,
            record.feedUrl || '',
            record.title || null,
            record.createdAt
              ? Math.floor(new Date(record.createdAt).getTime() / 1000)
              : Math.floor(Date.now() / 1000),
            sourceType,
            subjectDid,
            customTitle,
            customIconUrl,
            category
          )
          .run();
      } catch (dbError) {
        console.error(
          `[JetstreamPoller] D1 WRITE ERROR upserting subscription for ${did}:`,
          dbError
        );
        throw dbError;
      }

      console.log(
        `[JetstreamPoller] ${did} ${operation}d subscription: ${record.feedUrl || sourceType + ':' + subjectDid}`
      );
    } else if (operation === 'delete') {
      try {
        await this.env.DB.prepare('DELETE FROM subscriptions_cache WHERE record_uri = ?')
          .bind(recordUri)
          .run();
      } catch (dbError) {
        console.error(
          `[JetstreamPoller] D1 WRITE ERROR deleting subscription ${recordUri}:`,
          dbError
        );
        throw dbError;
      }

      console.log(`[JetstreamPoller] ${did} deleted subscription (rkey: ${rkey})`);
    }

    return true;
  }

  // --- Documents Stream ---
  // Watches site.standard.document events globally but only processes
  // events from users who are followed by at least one Skyreader user
  private async pollDocumentsStream(): Promise<{
    processed: number;
    errors: number;
  }> {
    // Fetch followed DIDs upfront to check before inserting
    const followedDids = await this.getFollowedDids();

    if (followedDids.size === 0) {
      console.log('[JetstreamPoller] No followed users to poll documents for');
      return { processed: 0, errors: 0 };
    }

    const cursor = await this.state.storage.get<string>('cursor_documents');

    const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
    wsUrl.searchParams.append('wantedCollections', 'site.standard.document');

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

      const cleanupWithCatch = () =>
        cleanup().catch((e) => console.error('[JetstreamPoller] documents cleanup error:', e));

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
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          ws = null;
        }

        await this.state.storage.put('cursor_documents', lastCursor);
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

            if (data.kind === 'commit' && data.commit?.collection === 'site.standard.document') {
              const wasProcessed = await this.processDocumentEvent(data, followedDids);
              if (wasProcessed) processed++;
            }
          } catch (error) {
            console.error('[JetstreamPoller] Error processing document event:', error);
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

  private async processDocumentEvent(
    event: JetstreamEvent,
    followedDids: Set<string>
  ): Promise<boolean> {
    const { did, commit } = event;
    if (!commit || commit.collection !== 'site.standard.document') return false;

    // Only process events from users who are followed by at least one Skyreader user
    if (!followedDids.has(did)) {
      return false;
    }

    const { operation, rkey, record, cid } = commit;
    const recordUri = `at://${did}/${commit.collection}/${rkey}`;

    if ((operation === 'create' || operation === 'update') && record && cid) {
      // NB: no placeholder `users` row is inserted for the author. `documents`
      // has no FK to `users` (migration 0030), and the sibling backfill path
      // (routes/social.ts) already inserts documents without one. Inserting a
      // registered_at-NULL row here only polluted `users`.

      // Resolve canonical_url from site + path
      const siteUri = record.site || '';
      const path = record.path || '';
      const canonicalUrl = await resolveCanonicalUrl(siteUri, path, this.env);

      // Parse publishedAt
      const publishedAtMs = record.publishedAt
        ? new Date(record.publishedAt).getTime()
        : Date.now();

      // Parse updatedAt
      const updatedAtMs = record.updatedAt ? new Date(record.updatedAt).getTime() : null;

      // Parse createdAt
      const createdAtMs = record.createdAt ? new Date(record.createdAt).getTime() : Date.now();

      // Extract cover image CID
      const coverImageCid = record.coverImage?.ref?.$link || null;

      // Extract bsky post URI
      const bskyPostUri = record.bskyPostRef?.uri || null;

      // Serialize content field if present (for documents, content is a structured object)
      const contentJson =
        record.content && typeof record.content === 'object'
          ? JSON.stringify(record.content)
          : null;

      try {
        await this.env.DB.prepare(
          `
					INSERT INTO documents
					(author_did, record_uri, record_cid, site_uri, title, published_at, path, description,
					 cover_image_cid, text_content, bsky_post_uri, tags, updated_at, canonical_url, content, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(record_uri) DO UPDATE SET
						record_cid = excluded.record_cid,
						site_uri = excluded.site_uri,
						title = excluded.title,
						published_at = excluded.published_at,
						path = excluded.path,
						description = excluded.description,
						cover_image_cid = excluded.cover_image_cid,
						text_content = excluded.text_content,
						bsky_post_uri = excluded.bsky_post_uri,
						tags = excluded.tags,
						updated_at = excluded.updated_at,
						canonical_url = excluded.canonical_url,
						content = excluded.content
					`
        )
          .bind(
            did,
            recordUri,
            cid,
            siteUri,
            record.title || '',
            publishedAtMs,
            path || null,
            record.description || null,
            coverImageCid,
            record.textContent || null,
            bskyPostUri,
            record.tags ? JSON.stringify(record.tags) : null,
            updatedAtMs,
            canonicalUrl || null,
            contentJson,
            createdAtMs
          )
          .run();
      } catch (dbError) {
        console.error(`[JetstreamPoller] D1 WRITE ERROR inserting document for ${did}:`, dbError);
        throw dbError;
      }

      console.log(`[JetstreamPoller] ${did} ${operation}d document: ${record.title}`);
    } else if (operation === 'delete') {
      try {
        await this.env.DB.prepare('DELETE FROM documents WHERE record_uri = ?')
          .bind(recordUri)
          .run();
      } catch (dbError) {
        console.error(`[JetstreamPoller] D1 WRITE ERROR deleting document ${recordUri}:`, dbError);
        throw dbError;
      }

      console.log(`[JetstreamPoller] ${did} deleted document (rkey: ${rkey})`);
    }

    return true;
  }

  // --- Saved Stream ---
  // Watches globally (all app.skyreader.feed.saved events) but only
  // processes events for registered Skyreader users
  private async pollSavedStream(): Promise<{
    processed: number;
    errors: number;
  }> {
    const registeredDids = await this.getRegisteredDidsSet();

    const cursor = await this.state.storage.get<string>('cursor_saved');

    const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
    wsUrl.searchParams.append('wantedCollections', 'app.skyreader.feed.saved');

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

      const cleanupWithCatch = () =>
        cleanup().catch((e) => console.error('[JetstreamPoller] saved cleanup error:', e));

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
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          ws = null;
        }

        await this.state.storage.put('cursor_saved', lastCursor);
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

            if (data.kind === 'commit' && data.commit?.collection === 'app.skyreader.feed.saved') {
              const wasProcessed = await this.processSavedEvent(data, registeredDids);
              if (wasProcessed) processed++;
            }
          } catch (error) {
            console.error('[JetstreamPoller] Error processing saved event:', error);
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

  private async processSavedEvent(
    event: JetstreamEvent,
    registeredDids: Set<string>
  ): Promise<boolean> {
    const { did, commit } = event;
    if (!commit || commit.collection !== 'app.skyreader.feed.saved') return false;

    // Only process events for registered Skyreader users
    if (!registeredDids.has(did)) {
      return false;
    }

    const { operation, rkey, record } = commit;
    const recordUri = `at://${did}/app.skyreader.feed.saved/${rkey}`;

    if (operation === 'create' && record) {
      try {
        // Insert saved metadata — DO NOT overwrite if it already exists (API handler
        // inserts with extracted content; Jetstream records have no content field)
        const result = await this.env.DB.prepare(
          `
          INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, description, content_type, domain, image, word_count, published_at, saved_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_did, rkey) DO NOTHING
          `
        )
          .bind(
            did,
            rkey,
            recordUri,
            record.url || '',
            record.title || null,
            record.description || null,
            record.contentType || 'webpage',
            record.domain || null,
            record.image || null,
            record.wordCount || null,
            record.publishedAt ? new Date(record.publishedAt).getTime() : null,
            record.savedAt ? new Date(record.savedAt).getTime() : Date.now(),
            Date.now()
          )
          .run();

        if (result.meta.changes > 0) {
          console.log(`[JetstreamPoller] ${did} created saved item: ${record.url}`);
        }
      } catch (dbError) {
        console.error(`[JetstreamPoller] D1 WRITE ERROR inserting saved item for ${did}:`, dbError);
        throw dbError;
      }
    } else if (operation === 'delete') {
      try {
        await this.env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ? AND rkey = ?')
          .bind(did, rkey)
          .run();
      } catch (dbError) {
        console.error(`[JetstreamPoller] D1 WRITE ERROR deleting saved item for ${did}:`, dbError);
        throw dbError;
      }

      console.log(`[JetstreamPoller] ${did} deleted saved item (rkey: ${rkey})`);
    }

    return true;
  }

  // --- Helper Methods ---
  /**
   * Get all DIDs that are followed by any Skyreader user (in-app follows).
   * Used for filtering document events.
   */
  private async getFollowedDids(): Promise<Set<string>> {
    // Active follows only — a parked atproto.documents sub (over the plan's
    // active capacity) isn't serviced, so we don't track its author's firehose
    // events. If every follower of a DID has it parked, we stop tracking it.
    const result = await this.env.DB.prepare(
      `SELECT DISTINCT subject_did as did FROM subscriptions_cache
       WHERE source_type = 'atproto.documents' AND subject_did IS NOT NULL AND active = 1`
    ).all<{ did: string }>();

    return new Set(result.results.map((r) => r.did));
  }

  /**
   * Get all sync-enabled user DIDs as a Set.
   * Used for checking if a user has sync enabled before processing events.
   */
  private async getSyncEnabledDidsSet(): Promise<Set<string>> {
    const result = await this.env.DB.prepare(
      `SELECT user_did as did FROM user_settings WHERE pds_sync_enabled = 1`
    ).all<{ did: string }>();

    return new Set(result.results.map((r) => r.did));
  }

  /**
   * Get all registered user DIDs as a Set.
   * Used for checking if a user is registered before processing saved events.
   */
  private async getRegisteredDidsSet(): Promise<Set<string>> {
    const result = await this.env.DB.prepare(
      `SELECT did FROM users WHERE registered_at IS NOT NULL`
    ).all<{ did: string }>();

    return new Set(result.results.map((r) => r.did));
  }
}
