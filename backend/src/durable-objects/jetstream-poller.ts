import * as Sentry from '@sentry/cloudflare';
import type { Env } from '../types';
import { upsertSubscriptionFromFirehose } from '../services/firehose-subscription';
import {
  createDocumentDrain,
  ensureAuthorDocuments,
  subscribedDocumentAuthors,
  type DocumentCommitEvent,
} from '../services/document-store';
import { readDocumentFlags } from '../services/document-flags';
import { DOCUMENT_COLLECTION, READER_COLLECTION } from '../services/standard-site';
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
    // Subscription records are read field-by-field here; document and
    // reader-collection records are handed to the document store whole, which owns
    // their shapes (`DocumentRecord` / `CollectionRecord`).
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

interface DocumentPollStats {
  processed: number;
  errors: number;
  /** The cycle stopped on the apply cap rather than on an empty stream. */
  capped: boolean;
  /** Consecutive capped cycles — a burst is 1–2, a flood keeps climbing. */
  capStreak: number;
  /** Authors in the connect-time `wantedDids` filter. */
  authors: number;
  /** The `documents_ingest_enabled` kill switch is off. */
  skipped: boolean;
}

interface PollStats {
  subscriptions: { processed: number; errors: number };
  documents: DocumentPollStats;
  duration: number;
  lastPollAt: number;
}

// Constants
const POLL_TIMEOUT_MS = 8000; // 8 seconds per stream
const IDLE_TIMEOUT_MS = 2000; // 2 seconds without events = caught up
const ALARM_INTERVAL_MS = 60000; // 60 seconds between polls

/**
 * Above this many subscribed authors the DID filter is sent as an `options_update`
 * frame after `open` instead of as `wantedDids` URL params. A few hundred DIDs is
 * already several kilobytes of query string, and an over-long upgrade request is
 * rejected by the server (the proxy's own comment recorded the same hazard) — which
 * would take the whole cycle's drain down. Well under any conservative URL ceiling.
 */
export const DID_URL_PARAM_LIMIT = 150;

/** Consecutive capped cycles that mean a sustained flood rather than a burst. */
export const CAP_SATURATION_ALERT_STREAK = 10;

/**
 * Jetstream's hard cap on `wantedDids`. Reaching it means the subscribed-author
 * set has outgrown a single subscription and wants sharding across alternating
 * cycles (or collection-only operation, justified by then-current volume).
 */
export const JETSTREAM_MAX_WANTED_DIDS = 10_000;

const CAP_STREAK_KEY = 'documents_cap_streak';

// Back catalogues pulled per cycle for subscriptions mirrored in from a PDS. Each
// is up to five `listRecords` pages against a foreign PDS, so this is deliberately
// small: the alarm's job is draining streams, and the queue survives to next cycle.
const MAX_CYCLE_BACKFILLS = 3;

// Ceiling on that queue. A device syncing a very long subscription list can enqueue
// faster than three a cycle drains, and this is in-memory state on a long-lived
// object; past the ceiling the surplus authors are left to the hourly reconcile,
// which is where they would have been before any of this existed.
const MAX_PENDING_BACKFILLS = 200;

// How long after an alarm *started* we still consider the poller alive without a
// scheduled alarm. `getAlarm()` returns null while the handler runs, so both
// `/start` (don't double-start) and `/status` consumers (don't cry wedged) need
// this window. Two alarm intervals: long enough to cover a slow cycle, short
// enough that a genuinely dead poller is caught within a couple of minutes.
export const ALARM_ACTIVE_WINDOW_MS = 2 * ALARM_INTERVAL_MS;

// Two streams: `app.skyreader.feed.subscription`, and the standard.site document
// pair (`site.standard.document` + its `app.standard-reader.collection` sidecar),
// which lived here before it moved to the proxy and has now come back. Everything
// stayed keyed by stream name for exactly this return.
type StreamName = 'subscriptions' | 'documents';

/**
 * Why a poll cycle stopped reading. Only `idle` means "Jetstream had nothing left";
 * `apply-cap` means we deliberately stopped early and carried the cursor.
 */
type PollExit = 'idle' | 'poll-timeout' | 'closed' | 'socket-error' | 'apply-cap';

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

const JETSTREAM_ENDPOINT = 'wss://jetstream2.us-east.bsky.network/subscribe';

/**
 * The document stream's connect-time subscription: both document collections, the
 * cursor, and the subscribed-author DID filter when it is small enough to ride the
 * URL.
 *
 * The filter is nearly free here, and that is the whole reason documents belong in
 * this DO rather than in a persistent socket. A long-lived connection has to *mutate*
 * its filter in place as subscriptions come and go — the machinery that cost the
 * proxy hundreds of lines of `options_update` reconciliation. This socket is torn
 * down and rebuilt every cycle, so the filter is just connect-time state read from
 * D1: at most one alarm interval stale, by construction, with no reconcile loop.
 *
 * Returns `viaFrame: true` when the set is too large for the URL, in which case the
 * caller sends one `options_update` frame on `open` instead (see `pollDocumentsStream`).
 */
export function buildDocumentSubscribeUrl(
  dids: string[],
  cursor?: string
): { url: string; viaFrame: boolean } {
  const wsUrl = new URL(JETSTREAM_ENDPOINT);
  wsUrl.searchParams.append('wantedCollections', DOCUMENT_COLLECTION);
  wsUrl.searchParams.append('wantedCollections', READER_COLLECTION);
  if (cursor) wsUrl.searchParams.set('cursor', cursor);

  const viaFrame = dids.length > DID_URL_PARAM_LIMIT;
  if (!viaFrame) {
    for (const did of dids) wsUrl.searchParams.append('wantedDids', did);
  }
  return { url: wsUrl.toString(), viaFrame };
}

class JetstreamPollerBase implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  /**
   * Authors whose documents this cycle's subscription events asked for. A
   * subscription created on another device arrives here rather than through the
   * API, so this is the fourth path that has to pull a back catalogue — but a
   * `listRecords` walk must not happen inside the drain, where it would stall the
   * socket, so the DIDs are collected and worked after both streams are closed.
   */
  private pendingDocumentBackfills = new Set<string>();

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
        documents: {
          processed: 0,
          errors: 0,
          capped: false,
          capStreak: 0,
          authors: 0,
          skipped: false,
        },
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

      // Documents (site.standard.document + its reader-collection sidecar). Its own
      // try/catch: a failing document drain must not cost the subscriptions stream
      // its cycle, which is the same isolation the ingest kill switch gives an
      // operator during a flood.
      try {
        stats.documents = await this.pollDocumentsStream();
      } catch (error) {
        log.error('jetstream_documents_poll_failed', { ...serializeError(error) });
        reportError(error, { tags: { source: 'jetstream-poller', phase: 'documents' } });
      }

      // Back catalogues for subscriptions this cycle mirrored in from a PDS. Both
      // sockets are closed by now, and the count is bounded, so a slow PDS costs
      // this cycle's tail rather than the drain window.
      try {
        await this.backfillPendingAuthors();
      } catch (error) {
        log.error('jetstream_documents_backfill_failed', { ...serializeError(error) });
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
      const [subscriptionsLagMs, documentsLagMs] = await Promise.all([
        this.streamLag('subscriptions'),
        this.streamLag('documents'),
      ]);

      log.info('jetstream_poll', {
        subscriptionsProcessed: stats.subscriptions.processed,
        subscriptionsErrors: stats.subscriptions.errors,
        subscriptionsLagMs,
        documentsProcessed: stats.documents.processed,
        documentsErrors: stats.documents.errors,
        documentsCapped: stats.documents.capped,
        documentsCapStreak: stats.documents.capStreak,
        documentsAuthors: stats.documents.authors,
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
   * Pull back catalogues for the authors this cycle's mirrored subscriptions
   * introduced. `ensureAuthorDocuments` skips an author we listed recently or one
   * inside their retry backoff, so a burst of subscription mirrors for a popular
   * linkblog is still one walk; the per-cycle bound keeps the tail short when a
   * device syncs a long subscription list at once — the rest are picked up by the
   * next cycle's queue or, failing that, by the hourly reconcile.
   */
  private async backfillPendingAuthors(): Promise<void> {
    if (this.pendingDocumentBackfills.size === 0) return;
    const dids = [...this.pendingDocumentBackfills].slice(0, MAX_CYCLE_BACKFILLS);
    // Only the ones being worked leave the queue; the remainder wait for the next
    // cycle rather than being dropped.
    for (const did of dids) this.pendingDocumentBackfills.delete(did);
    for (const did of dids) {
      try {
        await ensureAuthorDocuments(this.env, did);
      } catch (error) {
        log.warn('documents_backfill_failed', {
          authorDid: did,
          ...serializeError(error),
        });
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

  // --- Documents Stream ---
  // `site.standard.document` + `app.standard-reader.collection`, filtered
  // server-side to the DIDs someone actually subscribes to, then re-checked
  // per event before any write. See §3a of the plan for why the filter is the
  // first of five layers and what each of the others bounds.
  private async pollDocumentsStream(): Promise<DocumentPollStats> {
    const empty: DocumentPollStats = {
      processed: 0,
      errors: 0,
      capped: false,
      capStreak: 0,
      authors: 0,
      skipped: false,
    };

    const flags = await readDocumentFlags(this.env);
    if (!flags.ingestEnabled) {
      // The flood switch. Reads keep serving whatever D1 holds, the subscriptions
      // stream is untouched, and the cursor stays exactly where it was — so
      // flipping the flag back resumes the drain rather than skipping the backlog.
      log.info('documents_ingest_disabled');
      return { ...empty, skipped: true };
    }

    // The true active-author set, straight from the subscription table. No
    // read-traffic inference, and one alarm interval is the most it can be stale.
    const allAuthors = await subscribedDocumentAuthors(this.env);
    // Jetstream's hard cap on `wantedDids`. Past it the filter would be rejected
    // outright, so watch the first 10k rather than nothing; the per-event re-check
    // still keeps writes correct, and this line is the alert that the set needs
    // sharding across cycles.
    const dids = allAuthors.slice(0, JETSTREAM_MAX_WANTED_DIDS);
    if (allAuthors.length > dids.length) {
      log.warn('documents_did_filter_truncated', {
        authors: allAuthors.length,
        watching: dids.length,
      });
    }
    const allowed = new Set(dids);
    if (dids.length === 0) {
      // Nobody subscribes to any author's documents, so there is no stream to be
      // behind on. Mark caught up rather than letting the lag metric climb toward
      // an alert about an empty subscription set.
      await this.markCaughtUp('documents');
      return empty;
    }

    const cursor = await this.state.storage.get<string>(CURSOR_KEY.documents);
    const { url, viaFrame } = buildDocumentSubscribeUrl(dids, cursor);
    const priorStreak = (await this.state.storage.get<number>(CAP_STREAK_KEY)) ?? 0;

    return new Promise<DocumentPollStats>((resolve) => {
      let cleanedUp = false;
      let opened = false;
      let lastEventTime = Date.now();
      // Owns the cap, the error count and the cursor — which it only ever advances
      // past an event it finished, so a capped cycle resumes at the first event it
      // skipped rather than stepping over the rest of the burst.
      const drain = createDocumentDrain(this.env, { allowed, cap: flags.applyCap, cursor });
      // Jetstream delivers faster than D1 accepts writes, so handling has to be
      // serialized: concurrent handlers would both race the cap and reorder two
      // edits of the same rkey.
      let queue: Promise<void> = Promise.resolve();

      const cleanupWithCatch = (exit: PollExit) =>
        cleanup(exit).catch((e) => console.error('[JetstreamPoller] documents cleanup error:', e));

      const pollTimeout = setTimeout(() => cleanupWithCatch('poll-timeout'), POLL_TIMEOUT_MS);
      const idleCheck = setInterval(() => {
        if (Date.now() - lastEventTime > IDLE_TIMEOUT_MS) cleanupWithCatch('idle');
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

        // Let in-flight writes finish before the cursor is persisted, or a cycle
        // could record progress past an event it never applied.
        await queue.catch(() => {});

        await this.state.storage.put(CURSOR_KEY.documents, drain.cursor);

        const capStreak = drain.capped ? priorStreak + 1 : 0;
        await this.state.storage.put(CAP_STREAK_KEY, capStreak);

        // A drain is the only evidence the stream is current (see `streamLagMs`);
        // a capped cycle is the opposite of caught up, so it must not mark one.
        if (opened && exit === 'idle') await this.markCaughtUp('documents');

        if (drain.capped) {
          log.warn('documents_apply_cap_hit', {
            applied: drain.applied,
            cap: flags.applyCap,
            capStreak,
          });
        }

        resolve({
          processed: drain.applied,
          errors: drain.errors,
          capped: drain.capped,
          capStreak,
          authors: dids.length,
          skipped: false,
        });
      };

      const handle = async (data: JetstreamEvent) => {
        if (cleanedUp) return;
        if (data.kind !== 'commit' || !data.commit) return;
        const outcome = await drain.handle(data as DocumentCommitEvent & { time_us?: number });
        // Cap reached: stop reading now, with the cursor parked at the last event
        // this cycle finished. The rest of the burst is the next cycle's work.
        if (outcome === 'capped') cleanupWithCatch('apply-cap');
      };

      try {
        ws = new WebSocket(url);

        ws.addEventListener('open', () => {
          opened = true;
          lastEventTime = Date.now();
          if (viaFrame && ws) {
            // Too many DIDs for the URL. One frame, sent before anything can be
            // delivered; every DID in it was validated by `subscribedDocumentAuthors`,
            // because Jetstream rejects the whole frame on one malformed entry and
            // closes the socket.
            try {
              ws.send(
                JSON.stringify({
                  type: 'options_update',
                  payload: {
                    wantedCollections: [DOCUMENT_COLLECTION, READER_COLLECTION],
                    wantedDids: dids,
                  },
                })
              );
            } catch (error) {
              console.error('[JetstreamPoller] documents options_update failed:', error);
            }
          }
        });

        ws.addEventListener('message', (event) => {
          let data: JetstreamEvent;
          try {
            data = JSON.parse(event.data as string) as JetstreamEvent;
          } catch {
            // Unparseable frame: nothing to apply and nothing to advance past.
            console.error('[JetstreamPoller] documents: unparseable frame');
            return;
          }
          if (data.kind === 'commit') lastEventTime = Date.now();
          queue = queue.then(() => handle(data)).catch(() => {});
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
      // A mirrored `atproto.*` subscription needs the same back-catalogue pull the
      // API path does; queued, not run, so the drain stays a D1-only loop.
      if (
        typeof recAny.sourceType === 'string' &&
        recAny.sourceType.startsWith('atproto.') &&
        typeof recAny.subjectDid === 'string' &&
        this.pendingDocumentBackfills.size < MAX_PENDING_BACKFILLS
      ) {
        this.pendingDocumentBackfills.add(recAny.subjectDid);
      }
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
