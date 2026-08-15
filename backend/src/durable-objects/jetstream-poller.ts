import * as Sentry from '@sentry/cloudflare';
import type { Env } from '../types';
import { resolveCanonicalUrl } from '../utils/canonical-url';
import { upsertSubscriptionFromFirehose } from '../services/firehose-subscription';
import { sentryOptions, reportError } from '../observability/sentry';
import { log, serializeError } from '../utils/logger';
import { runWithRequestContext } from '../utils/request-context';

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
      siteUrl?: string; // For subscription records: the public linkblog page
      // For site.standard.document records
      site?: string;
      publishedAt?: string;
      path?: string;
      description?: string;
      coverImage?: { ref: { $link: string }; mimeType: string };
      textContent?: string;
      bskyPostRef?: { uri: string; cid: string };
      updatedAt?: string;
    };
    cid?: string;
  };
}

interface PollStats {
  subscriptions: { processed: number; errors: number };
  documents: { processed: number; errors: number };
  duration: number;
  lastPollAt: number;
}

// Constants
const POLL_TIMEOUT_MS = 8000; // 8 seconds per stream
const IDLE_TIMEOUT_MS = 2000; // 2 seconds without events = caught up
const ALARM_INTERVAL_MS = 60000; // 60 seconds between polls

// How long after an alarm *started* we still consider the poller alive without a
// scheduled alarm. `getAlarm()` returns null while the handler runs, so both
// `/start` (don't double-start) and `/status` consumers (don't cry wedged) need
// this window. Two alarm intervals: long enough to cover a slow cycle, short
// enough that a genuinely dead poller is caught within a couple of minutes.
export const ALARM_ACTIVE_WINDOW_MS = 2 * ALARM_INTERVAL_MS;

type StreamName = 'subscriptions' | 'documents';

/** Why a poll cycle stopped reading. Only `idle` means "Jetstream had nothing left". */
type PollExit = 'idle' | 'poll-timeout' | 'closed' | 'socket-error';

const CURSOR_KEY = {
  subscriptions: 'cursor_subscriptions',
  documents: 'cursor_documents',
} as const;

// When each stream was last *confirmed current* — a cycle that opened the socket
// and then went IDLE_TIMEOUT_MS without a commit, which is Jetstream saying it has
// nothing more for us.
const CAUGHT_UP_KEY = {
  subscriptions: 'caughtup_subscriptions',
  documents: 'caughtup_documents',
} as const;

/**
 * How far behind the stream is, in ms.
 *
 * Cursor age is the intuitive measure and it is wrong here. A cursor only moves
 * when an event arrives, and both streams filter on a single collection, so a
 * quiet collection freezes its cursor while the poller is perfectly healthy —
 * staging sat at a 36h "lag" against a poller that was polling every minute,
 * draining to idle in ~3s, with zero errors. Alerting on that measures how busy
 * the network is, not whether we are keeping up.
 *
 * So lag is time since the stream was last confirmed current. An idle exit proves
 * we were current at that instant (the file's own IDLE_TIMEOUT_MS comment has said
 * "caught up" all along); a cycle that hits the poll timeout while events are
 * still arriving, or that never opens the socket at all, proves nothing and lets
 * this number keep climbing until it crosses the alert threshold. That also fixes
 * a gap in the old measure: with a rare collection, Jetstream being unreachable
 * produced no lag signal whatsoever, because a cursor that never advances looks
 * identical whether the stream is quiet or gone.
 *
 * Cursor age remains the fallback for a stream that has never once drained, and
 * the raw cursors stay on /status for debugging. Null means "unknown", not "zero".
 */
export function streamLagMs(
  caughtUpAt: number | null | undefined,
  cursor: string | null | undefined,
  now: number
): number | null {
  if (typeof caughtUpAt === 'number' && Number.isFinite(caughtUpAt) && caughtUpAt > 0) {
    return Math.max(0, now - caughtUpAt);
  }
  if (!cursor) return null;
  const cursorUs = Number(cursor);
  if (!Number.isFinite(cursorUs) || cursorUs <= 0) return null;
  return Math.max(0, now - Math.round(cursorUs / 1000));
}

class JetstreamPollerBase implements DurableObject {
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

      const recentlyActive = lastAlarmStart && Date.now() - lastAlarmStart < ALARM_ACTIVE_WINDOW_MS;

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
      const [
        subscriptionsCursor,
        documentsCursor,
        lastStats,
        alarmTime,
        lastAlarmStart,
        subscriptionsLagMs,
        documentsLagMs,
      ] = await Promise.all([
        this.state.storage.get<string>('cursor_subscriptions'),
        this.state.storage.get<string>('cursor_documents'),
        this.state.storage.get<PollStats>('last_stats'),
        this.state.storage.getAlarm(),
        this.state.storage.get<number>('last_alarm_start'),
        this.streamLag('subscriptions'),
        this.streamLag('documents'),
      ]);

      return new Response(
        JSON.stringify({
          cursors: {
            subscriptions: subscriptionsCursor,
            documents: documentsCursor,
          },
          // Lag is derived here rather than by each caller: knowing what "behind"
          // means for a filtered Jetstream stream (see `streamLagMs`) should live
          // in exactly one place. Null means "unknown", not "zero lag".
          lag: {
            subscriptionsMs: subscriptionsLagMs,
            documentsMs: documentsLagMs,
          },
          lastStats,
          nextPoll: alarmTime,
          // `getAlarm()` returns null *while the alarm handler is running*, and a
          // poll cycle occupies a real fraction of every minute (two streams, each
          // 2–8s). A caller that reads `isRunning` alone would see false during
          // that window and conclude the firehose is dead — so surface
          // `lastAlarmStart` too and let it apply the same recency rule /start
          // uses (see above). Callers: routes/health.ts.
          isRunning: !!alarmTime,
          lastAlarmStart: lastAlarmStart ?? null,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    // Every line and every Sentry event from this poll cycle shares one id, so a
    // bad cycle can be read end to end from a single filter.
    return runWithRequestContext({ requestId: crypto.randomUUID(), route: 'jetstream-poll' }, () =>
      this.runPollCycle()
    );
  }

  private async runPollCycle(): Promise<void> {
    // Record when this alarm started to prevent race conditions with /start
    // (cron calls /start every minute, but getAlarm() returns null while running)
    await this.state.storage.put('last_alarm_start', Date.now());

    // Top-level try-catch to ensure we NEVER crash the alarm handler
    // The finally block ensures we always schedule the next alarm
    try {
      const startTime = Date.now();
      log.info('jetstream_poll_start');

      const stats: PollStats = {
        subscriptions: { processed: 0, errors: 0 },
        documents: { processed: 0, errors: 0 },
        duration: 0,
        lastPollAt: startTime,
      };

      try {
        // Poll streams sequentially to reduce peak CPU usage
        // 1. Subscriptions (app.skyreader.feed.subscription) - global watch, filter by sync-enabled
        const subscriptionsResult = await this.pollSubscriptionsStream();
        stats.subscriptions = subscriptionsResult;

        // 2. Documents (site.standard.document) - filter to followed users
        const documentsResult = await this.pollDocumentsStream();
        stats.documents = documentsResult;
      } catch (error) {
        log.error('jetstream_poll_failed', { ...serializeError(error) });
        reportError(error, { tags: { source: 'jetstream-poller', phase: 'poll-cycle' } });
      }

      stats.duration = Date.now() - startTime;

      // Save stats (best effort)
      try {
        await this.state.storage.put('last_stats', stats);
      } catch (error) {
        console.error('[JetstreamPoller] Error saving stats:', error);
      }

      // Time since each stream last drained to idle. Logging it every cycle turns
      // "the firehose is stalled" from something you notice when shares stop
      // appearing into a number with a history.
      const [subscriptionsLagMs, documentsLagMs] = await Promise.all([
        this.streamLag('subscriptions'),
        this.streamLag('documents'),
      ]);

      log.info('jetstream_poll', {
        subscriptionsProcessed: stats.subscriptions.processed,
        subscriptionsErrors: stats.subscriptions.errors,
        documentsProcessed: stats.documents.processed,
        documentsErrors: stats.documents.errors,
        subscriptionsLagMs,
        documentsLagMs,
        durationMs: stats.duration,
      });
    } catch (error) {
      // Catch-all for any unexpected errors
      log.error('jetstream_alarm_failed', { ...serializeError(error) });
      reportError(error, { tags: { source: 'jetstream-poller', phase: 'alarm' } });
    } finally {
      // ALWAYS schedule next poll - this runs even if an error occurred above
      try {
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      } catch (error) {
        // The firehose stops here until the next cron /start ping revives it, so
        // this one is worth a page rather than a log line.
        console.error('[JetstreamPoller] CRITICAL: Error scheduling next alarm:', error);
        reportError(error, { tags: { source: 'jetstream-poller', phase: 'alarm-scheduling' } });
      }
    }
  }

  /**
   * How far behind a stream is, in ms. See `streamLagMs` for why this is measured
   * from the last confirmed drain rather than from the cursor.
   */
  private async streamLag(stream: StreamName): Promise<number | null> {
    try {
      const [caughtUpAt, cursor] = await Promise.all([
        this.state.storage.get<number>(CAUGHT_UP_KEY[stream]),
        this.state.storage.get<string>(CURSOR_KEY[stream]),
      ]);
      return streamLagMs(caughtUpAt, cursor, Date.now());
    } catch {
      return null;
    }
  }

  /**
   * Record that a stream is current as of now. Best effort: losing this write
   * costs one cycle's worth of freshness in a metric, and must never take down a
   * poll cycle that otherwise succeeded.
   */
  private async markCaughtUp(stream: StreamName): Promise<void> {
    try {
      await this.state.storage.put(CAUGHT_UP_KEY[stream], Date.now());
    } catch (error) {
      console.error(`[JetstreamPoller] Error recording ${stream} caught-up time:`, error);
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
      let opened = false;

      const cleanupWithCatch = (exit: PollExit) =>
        cleanup(exit).catch((e) =>
          console.error('[JetstreamPoller] subscriptions cleanup error:', e)
        );

      const pollTimeout = setTimeout(() => cleanupWithCatch('poll-timeout'), POLL_TIMEOUT_MS);
      const idleCheck = setInterval(() => {
        if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) {
          cleanupWithCatch('idle');
        }
      }, 500);

      let ws: WebSocket | null = null;

      const cleanup = async (exit: PollExit) => {
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
        // `opened` matters as much as the exit reason: the idle check starts
        // running before the socket connects, so a Jetstream that never answers
        // would otherwise idle out and be recorded as "caught up".
        if (opened && exit === 'idle') await this.markCaughtUp('subscriptions');
        resolve({ processed, errors });
      };

      try {
        ws = new WebSocket(wsUrl.toString());

        ws.addEventListener('open', () => {
          opened = true;
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

        ws.addEventListener('close', () => cleanupWithCatch('closed'));
        ws.addEventListener('error', () => cleanupWithCatch('socket-error'));
      } catch {
        cleanupWithCatch('socket-error');
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
      try {
        await upsertSubscriptionFromFirehose(this.env.DB, did, rkey, record);
      } catch (dbError) {
        console.error(
          `[JetstreamPoller] D1 WRITE ERROR upserting subscription for ${did}:`,
          dbError
        );
        throw dbError;
      }

      const recAny = record as Record<string, unknown>;
      console.log(
        `[JetstreamPoller] ${did} ${operation}d subscription: ${
          record.feedUrl || `${recAny.sourceType}:${recAny.subjectDid}`
        }`
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
      // A stream with nothing to watch is current by definition. Without this the
      // lag would climb forever on an instance that simply has no follows yet —
      // which is every fresh staging database.
      await this.markCaughtUp('documents');
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
      let opened = false;

      const cleanupWithCatch = (exit: PollExit) =>
        cleanup(exit).catch((e) => console.error('[JetstreamPoller] documents cleanup error:', e));

      const pollTimeout = setTimeout(() => cleanupWithCatch('poll-timeout'), POLL_TIMEOUT_MS);
      const idleCheck = setInterval(() => {
        if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) {
          cleanupWithCatch('idle');
        }
      }, 500);

      let ws: WebSocket | null = null;

      const cleanup = async (exit: PollExit) => {
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
        // See the same guard in pollSubscriptionsStream: only a cycle that
        // actually connected and then went quiet proves we are current.
        if (opened && exit === 'idle') await this.markCaughtUp('documents');
        resolve({ processed, errors });
      };

      try {
        ws = new WebSocket(wsUrl.toString());

        ws.addEventListener('open', () => {
          opened = true;
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

        ws.addEventListener('close', () => cleanupWithCatch('closed'));
        ws.addEventListener('error', () => cleanupWithCatch('socket-error'));
      } catch {
        cleanupWithCatch('socket-error');
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
}

// Instrumented at the export so exceptions escaping `fetch`/`alarm` reach Sentry,
// and — just as importantly — so the SDK is initialized inside this DO's isolate,
// which is what makes the `reportError()` calls above actually send. The cast
// bridges the ambient `DurableObject` interface this class implements to the
// `cloudflare:workers` base class the instrumenter's types expect; the runtime
// contract (constructor(state, env) + fetch/alarm) is identical.
export const JetstreamPoller = Sentry.instrumentDurableObjectWithSentry(
  sentryOptions,
  JetstreamPollerBase as unknown as new (
    state: DurableObjectState,
    env: Env
  ) => InstanceType<typeof JetstreamPollerBase> & { ctx: DurableObjectState; env: Env }
) as unknown as typeof JetstreamPollerBase;
