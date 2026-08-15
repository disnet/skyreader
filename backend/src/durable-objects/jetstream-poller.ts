import * as Sentry from '@sentry/cloudflare';
import type { Env } from '../types';
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
    // Only `app.skyreader.feed.subscription` records reach this DO now.
    record?: {
      $type: string;
      feedUrl?: string;
      tags?: string[];
      createdAt?: string;
      title?: string;
      category?: string;
      siteUrl?: string; // The public linkblog page
    };
    cid?: string;
  };
}

interface PollStats {
  subscriptions: { processed: number; errors: number };
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

// One stream today (`app.skyreader.feed.subscription`). The plumbing stays keyed
// by name because the `site.standard.document` stream lived here until documents
// moved to on-demand proxy fetch, and a second stream is a plausible future.
type StreamName = 'subscriptions';

/** Why a poll cycle stopped reading. Only `idle` means "Jetstream had nothing left". */
type PollExit = 'idle' | 'poll-timeout' | 'closed' | 'socket-error';

const CURSOR_KEY = {
  subscriptions: 'cursor_subscriptions',
} as const;

// When each stream was last *confirmed current* — a cycle that opened the socket
// and then went IDLE_TIMEOUT_MS without a commit, which is Jetstream saying it has
// nothing more for us.
const CAUGHT_UP_KEY = {
  subscriptions: 'caughtup_subscriptions',
} as const;

/**
 * How far behind the stream is, in ms: time since the most recent evidence that it
 * was current.
 *
 * There are two independent pieces of such evidence, and the essential thing about
 * both is that they are **one-sided**. Each can prove we were current at a moment;
 * neither can prove we weren't.
 *
 *   - A drain. A cycle that connected and then went IDLE_TIMEOUT_MS without a
 *     commit is Jetstream saying it has nothing more for us.
 *   - A fresh cursor. Cursors are microsecond timestamps of received events, so a
 *     recent one means we were reading the live edge of the stream.
 *
 * Using either one alone produces a false alarm on the traffic pattern it can't
 * see. Cursor age alone reports how busy the collection is: staging showed a 36h
 * "lag" against a poller doing a clean 3s cycle every minute, because nobody
 * anywhere had written an `app.skyreader.feed.subscription` record in 36h. Drains
 * alone report how bursty it is: a collection busy enough that no 2-second gap
 * ever falls inside the 8-second poll window exits on POLL_TIMEOUT_MS every cycle
 * while being perfectly caught up.
 *
 * So take the minimum — the most recent proof of currency from either source. A
 * stream that is genuinely behind has neither: it is draining a backlog, so its
 * cursor sits at the old events it's working through, and its cycles end on the
 * poll timeout rather than idle. Same when Jetstream is unreachable: no events, no
 * drains, both numbers climb together and the alert fires. Null means "unknown",
 * not "zero" — decideLagAlert deliberately never pages on it.
 */
export function streamLagMs(
  caughtUpAt: number | null | undefined,
  cursor: string | null | undefined,
  now: number
): number | null {
  const sinceDrain =
    typeof caughtUpAt === 'number' && Number.isFinite(caughtUpAt) && caughtUpAt > 0
      ? Math.max(0, now - caughtUpAt)
      : null;

  const cursorUs = cursor ? Number(cursor) : NaN;
  const sinceEvent =
    Number.isFinite(cursorUs) && cursorUs > 0
      ? Math.max(0, now - Math.round(cursorUs / 1000))
      : null;

  if (sinceDrain === null) return sinceEvent;
  if (sinceEvent === null) return sinceDrain;
  return Math.min(sinceDrain, sinceEvent);
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
      const [subscriptionsCursor, lastStats, alarmTime, lastAlarmStart, subscriptionsLagMs] =
        await Promise.all([
          this.state.storage.get<string>('cursor_subscriptions'),
          this.state.storage.get<PollStats>('last_stats'),
          this.state.storage.getAlarm(),
          this.state.storage.get<number>('last_alarm_start'),
          this.streamLag('subscriptions'),
        ]);

      return new Response(
        JSON.stringify({
          cursors: {
            subscriptions: subscriptionsCursor,
          },
          // Lag is derived here rather than by each caller: knowing what "behind"
          // means for a filtered Jetstream stream (see `streamLagMs`) should live
          // in exactly one place. Null means "unknown", not "zero lag".
          lag: {
            subscriptionsMs: subscriptionsLagMs,
          },
          lastStats,
          nextPoll: alarmTime,
          // `getAlarm()` returns null *while the alarm handler is running*, and a
          // poll cycle occupies a real fraction of every minute (2–8s). A caller
          // that reads `isRunning` alone would see false during that window and
          // conclude the firehose is dead — so surface `lastAlarmStart` too and let
          // it apply the same recency rule /start uses (see above). Callers:
          // routes/health.ts.
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
        duration: 0,
        lastPollAt: startTime,
      };

      try {
        // Subscriptions (app.skyreader.feed.subscription) - global watch, filter by sync-enabled
        const subscriptionsResult = await this.pollSubscriptionsStream();
        stats.subscriptions = subscriptionsResult;
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

      // Time since the stream last showed evidence of being current. Logging it
      // every cycle turns "the firehose is stalled" from something you notice when
      // subscriptions stop syncing into a number with a history.
      const subscriptionsLagMs = await this.streamLag('subscriptions');

      log.info('jetstream_poll', {
        subscriptionsProcessed: stats.subscriptions.processed,
        subscriptionsErrors: stats.subscriptions.errors,
        subscriptionsLagMs,
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

  // --- Helper Methods ---
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
