/**
 * Jetstream firehose consumer for `site.standard.document` records.
 *
 * Replaces the periodic full re-list of every active author (the old
 * `warmStaleDocuments` loop) with a push-based stream: we subscribe to the AT
 * Proto firehose, filtered *server-side* to the DIDs we actually serve
 * (`wantedDids`), and splice each create/update/delete straight into
 * `document_cache`. Documents stay fresh in near-real-time and we stop
 * re-fetching authors who never changed.
 *
 * The lazy pull path (`fetchDocumentsForAuthor`) remains the source of truth for
 * cold-start backfill — the firehose never replays history — and for the
 * firehose-down fallback. This consumer only keeps already-cached authors
 * current.
 *
 * Runs as a long-lived WebSocket in the Bun process (the feed-proxy is a natural
 * home for a persistent connection, unlike the backend's Durable-Object poller).
 */
import { Database } from 'bun:sqlite';
import {
  isValidDid,
  recordToProxyDocument,
  MAX_DOCUMENTS_PER_AUTHOR,
  type DocumentRecord,
  type ProxyDocument,
} from './standard-site';

const DEFAULT_JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe';
const DOCUMENT_COLLECTION = 'site.standard.document';
const CURSOR_KEY = 'jetstream_cursor_documents';
// Jetstream's hard cap is 10,000 wantedDids per connection. We send the DID set
// over the socket via an `options_update` message (not in the handshake URL), so
// the only ceiling that bites is this logical cap — large sets no longer risk a
// rejected upgrade from an oversized request URL. Beyond 10k, DID-set sharding
// across connections is the follow-up (see plan); until then we watch the
// most-recently-requested 10k and let the rest fall back to age-based refresh.
const MAX_WANTED_DIDS = 10_000;
const RECONNECT_MAX_MS = 30_000;
// WebSocket-level liveness. The subscription is filtered to our DIDs + one
// collection, so at low volume a perfectly healthy stream can be silent for
// minutes — document arrival can't prove the socket is alive. Instead we ping
// the server on a fixed cadence and watch for *any* returned frame; RFC 6455
// guarantees a pong, so this works even when no documents are flowing.
const PING_INTERVAL_MS = 30_000;
// Treat the socket as dead if no frame (pong/message/ping) arrives within this
// window (≈3 missed pings). Drives both isHealthy() and a forced reconnect.
const PING_TIMEOUT_MS = 90_000;
// How long a socket must stay open before we treat the connection as good and
// clear the reconnect backoff. Anything shorter is a failed attempt, however far
// into the handshake it got.
const STABLE_CONNECTION_MS = 60_000;

/** Status accessor handed to the serve path so it can trust the cache for
 *  authors the firehose is actively keeping fresh. */
export interface FirehoseStatus {
  healthy: boolean;
  connected?: boolean;
  subscribedDids?: number;
  lastEventAt?: number | null;
  reconnectAttempts?: number;
  cursor?: string | null;
  isSubscribed: (did: string) => boolean;
}

export interface DocumentFirehoseConfig {
  enabled?: boolean;
  url?: string;
  // How often to recompute the active-author set and reconnect if it changed.
  reconcileMs?: number;
  // Authors requested by a client within this window are kept fresh by the
  // stream; matches the warm loop's active window.
  activeWindowMs?: number;
}

interface JetstreamCommit {
  operation: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  record?: DocumentRecord;
  cid?: string;
}

interface JetstreamEvent {
  did: string;
  time_us?: number;
  kind: 'commit' | 'identity' | 'account';
  commit?: JetstreamCommit;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export class DocumentFirehose {
  private readonly db: Database;
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly reconcileMs: number;
  private readonly activeWindowMs: number;

  private running = false;
  private connected = false;
  private ws: WebSocket | null = null;
  private subscribedDids = new Set<string>();
  // The filter the server has actually accepted for the current socket. Keep it
  // separate from the desired set: a failed options_update must remain dirty so
  // reconcile retries it instead of trusting a filter the server never saw.
  private sentDids = new Set<string>();
  private lastCursor: string | null = null;
  private lastEventAt = 0;
  // Timestamp of the last frame of *any* kind (message/ping/pong) on the live
  // socket — the liveness signal, distinct from lastEventAt (matching docs only).
  private lastActivityAt = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  // Fires once a connection has stayed up long enough to count as good; only
  // then is the reconnect backoff cleared.
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  // The malformed-DID set last reported, so the periodic reconcile doesn't
  // re-log an unchanged one every tick.
  private lastInvalidKey = '';
  // Serialize message processing so events for the same record apply in order
  // (the async publication resolution would otherwise let them interleave).
  private queue: Promise<void> = Promise.resolve();

  constructor(db: Database, config: DocumentFirehoseConfig = {}) {
    this.db = db;
    this.enabled = config.enabled ?? true;
    this.url = config.url || DEFAULT_JETSTREAM_URL;
    this.reconcileMs = config.reconcileMs ?? 60_000;
    this.activeWindowMs = config.activeWindowMs ?? 14 * 24 * 60 * 60 * 1000;
  }

  // --- Public surface ---------------------------------------------------------

  start(): void {
    if (!this.enabled) {
      console.log('[Firehose] disabled');
      return;
    }
    if (this.running) return;
    this.running = true;
    this.lastCursor = this.readCursor();
    this.subscribedDids = new Set(this.computeActiveDids(Date.now()));
    console.log(
      `[Firehose] starting; ${this.subscribedDids.size} active author(s), ` +
        `reconcile every ${this.reconcileMs / 1000}s`
    );
    this.connect();
    this.reconcileTimer = setInterval(() => {
      try {
        this.reconcile();
      } catch (err) {
        console.error('[Firehose] reconcile error:', err);
      }
    }, this.reconcileMs);
  }

  stop(): void {
    this.running = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.flushCursor();
    this.closeSocket();
  }

  isHealthy(): boolean {
    if (!this.enabled || !this.connected) return false;
    // A still-open socket isn't proof of liveness — require a recent frame. Our
    // pings guarantee a pong every PING_INTERVAL_MS on a live connection, so a
    // quiet stream stays healthy while a stalled/half-open one does not.
    return Date.now() - this.lastActivityAt < PING_TIMEOUT_MS;
  }

  isSubscribed(did: string): boolean {
    // The serve path uses this as permission to trust the spliced cache. Only
    // report filters successfully sent on the current socket, not desired DIDs
    // still waiting for an options_update/reconnect.
    return this.sentDids.has(did);
  }

  status(): FirehoseStatus {
    return {
      healthy: this.isHealthy(),
      connected: this.connected,
      subscribedDids: this.subscribedDids.size,
      lastEventAt: this.lastEventAt || null,
      reconnectAttempts: this.reconnectAttempts,
      cursor: this.lastCursor,
      isSubscribed: (did) => this.isSubscribed(did),
    };
  }

  // --- Active-author set ------------------------------------------------------

  /** The DIDs to watch: authors requested by a client within the active window,
   *  newest-request first, capped at the wantedDids limit. */
  computeActiveDids(now: number): string[] {
    const rows = this.db
      .query<{ did: string }, [number]>(
        `SELECT did FROM document_cache
				WHERE last_requested_at IS NOT NULL AND last_requested_at > ?
				ORDER BY last_requested_at DESC`
      )
      .all(now - this.activeWindowMs);

    // Jetstream validates every entry in `wantedDids` and rejects the *whole*
    // options_update if any one is malformed — it answers with a close, so a
    // single junk row in document_cache would otherwise put the stream in a
    // permanent connect/close/reconnect loop. Drop them here instead.
    const dids: string[] = [];
    const invalid: string[] = [];
    for (const row of rows) {
      if (isValidDid(row.did)) dids.push(row.did);
      else invalid.push(row.did);
    }
    // Reconcile runs on a timer, so only report a *change* — the same bad rows
    // are otherwise re-announced every minute forever.
    const invalidKey = invalid.join(' ');
    if (invalid.length > 0 && invalidKey !== this.lastInvalidKey) {
      console.warn(
        `[Firehose] skipping ${invalid.length} cached author(s) with a malformed DID: ` +
          invalid
            .slice(0, 5)
            .map((d) => JSON.stringify(d))
            .join(', ') +
          (invalid.length > 5 ? ', …' : '')
      );
    }
    this.lastInvalidKey = invalidKey;

    if (dids.length > MAX_WANTED_DIDS) {
      console.warn(
        `[Firehose] ${dids.length} active authors exceed wantedDids cap ${MAX_WANTED_DIDS}; ` +
          `watching the ${MAX_WANTED_DIDS} most recently requested ` +
          `(${dids.length - MAX_WANTED_DIDS} fall back to age-based refresh)`
      );
      return dids.slice(0, MAX_WANTED_DIDS);
    }
    return dids;
  }

  /** Recompute the active set; reconnect only if it actually changed (the
   *  wantedDids filter is fixed per-connection). Public for tests. */
  reconcile(): void {
    const next = new Set(this.computeActiveDids(Date.now()));
    const desiredChanged = !setsEqual(next, this.subscribedDids);
    if (!desiredChanged && setsEqual(next, this.sentDids)) {
      this.flushCursor();
      return;
    }
    this.subscribedDids = next;
    if (desiredChanged) console.log(`[Firehose] active author set changed → ${next.size}`);
    this.flushCursor();
    if (!this.running) return;
    if (next.size === 0) {
      this.closeSocket();
      return;
    }
    // Push the new DID filter over the live socket instead of tearing it down —
    // a reconnect on every set change hammered the public endpoint with
    // handshakes. Fall back to (re)connect only if we don't have an open socket.
    if (this.connected && this.ws) {
      this.sendOptionsUpdate(this.ws);
    } else {
      this.reconnect();
    }
  }

  /** Send the current collection + DID filter as a Jetstream `options_update`
   *  message. Used both on `open` (the URL carries no DIDs) and on reconcile to
   *  narrow/widen the watched set without reconnecting. The message replaces the
   *  connection's whole filter, so it must carry both fields. */
  private sendOptionsUpdate(ws: WebSocket): boolean {
    const message = {
      type: 'options_update',
      payload: {
        wantedCollections: [DOCUMENT_COLLECTION],
        wantedDids: [...this.subscribedDids],
      },
    };
    try {
      ws.send(JSON.stringify(message));
      this.sentDids = new Set(this.subscribedDids);
      return true;
    } catch (err) {
      console.error('[Firehose] options_update send failed:', err);
      this.sentDids.clear();
      // The socket's server-side filter is now unknowable. Close it and use the
      // normal capped reconnect backoff; reconnecting immediately here creates
      // a handshake-rate loop when every open socket rejects send().
      if (this.ws === ws) {
        this.closeSocket();
        this.scheduleReconnect();
      }
      return false;
    }
  }

  // --- Event application ------------------------------------------------------

  /**
   * Apply one `site.standard.document` commit to `document_cache`. Resolves the
   * record to a `ProxyDocument` (async, may fetch publication meta) *before* the
   * synchronous read-modify-write so concurrent events can't interleave the
   * splice. Public for tests. Returns true if the event was a relevant op.
   */
  async applyDocumentEvent(event: JetstreamEvent): Promise<boolean> {
    const { did, commit } = event;
    if (!commit || commit.collection !== DOCUMENT_COLLECTION) return false;

    const recordUri = `at://${did}/${commit.collection}/${commit.rkey}`;
    const { operation, record, cid } = commit;

    if ((operation === 'create' || operation === 'update') && record && cid) {
      const doc = await recordToProxyDocument(this.db, did, recordUri, cid, record);
      this.spliceDocument(did, doc);
      return true;
    }
    if (operation === 'delete') {
      this.removeDocument(did, recordUri);
      return true;
    }
    return false;
  }

  /** Synchronous read-modify-write: merge a document into the author's cached
   *  list (replace-by-uri / insert), re-sort newest-first, trim to the cap. */
  private spliceDocument(authorDid: string, doc: ProxyDocument): void {
    const row = this.db
      .query<{ documents_json: string }, [string]>(
        'SELECT documents_json FROM document_cache WHERE did = ?'
      )
      .get(authorDid);
    // No cache row → author not backfilled (or aged out). Don't synthesize a
    // partial history here; the request path backfills the full list.
    if (!row) return;

    const list: ProxyDocument[] = row.documents_json ? JSON.parse(row.documents_json) : [];
    const merged = list.filter((d) => d.recordUri !== doc.recordUri);
    merged.push(doc);
    merged.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    const trimmed = merged.slice(0, MAX_DOCUMENTS_PER_AUTHOR);

    const now = Date.now();
    this.db.run(
      'UPDATE document_cache SET documents_json = ?, cached_at = ?, fetched_at = ? WHERE did = ?',
      [JSON.stringify(trimmed), now, now, authorDid]
    );
  }

  private removeDocument(authorDid: string, recordUri: string): void {
    const row = this.db
      .query<{ documents_json: string }, [string]>(
        'SELECT documents_json FROM document_cache WHERE did = ?'
      )
      .get(authorDid);
    if (!row?.documents_json) return;

    const list: ProxyDocument[] = JSON.parse(row.documents_json);
    const filtered = list.filter((d) => d.recordUri !== recordUri);
    if (filtered.length === list.length) return; // nothing to remove

    const now = Date.now();
    this.db.run(
      'UPDATE document_cache SET documents_json = ?, cached_at = ?, fetched_at = ? WHERE did = ?',
      [JSON.stringify(filtered), now, now, authorDid]
    );
  }

  // --- Connection -------------------------------------------------------------

  private connect(): void {
    if (!this.running) return;
    if (this.subscribedDids.size === 0) {
      // Nothing to watch yet; the reconciler reconnects when authors appear.
      this.connected = false;
      return;
    }

    const url = new URL(this.url);
    url.searchParams.set('wantedCollections', DOCUMENT_COLLECTION);
    if (this.lastCursor) url.searchParams.set('cursor', this.lastCursor);
    // The DID filter is sent over the socket via `options_update` after `open`,
    // NOT in the URL. One `?wantedDids=` param per author grows the handshake
    // request line by ~56 bytes/DID, so a few hundred active authors already
    // exceed the fronting proxy's URL/header limit and the upgrade is rejected
    // with a non-101 response ("Expected 101 status code") instead of connecting.
    // Until the update lands we briefly match all authors for this (low-volume)
    // collection; foreign-author events are harmless no-ops (spliceDocument drops
    // any author without a cache row).

    let ws: WebSocket;
    try {
      ws = new WebSocket(url.toString());
    } catch (err) {
      console.error('[Firehose] connect failed:', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      const now = Date.now();
      this.lastEventAt = now;
      this.lastActivityAt = now;
      console.log(`[Firehose] connected, watching ${this.subscribedDids.size} author(s)`);
      if (!this.sendOptionsUpdate(ws)) return;
      this.startPingTimer(ws);
      // Clear the backoff only once the connection has *held*. Resetting on
      // `open` alone turns any instant-close condition (a rejected
      // options_update, an upstream refusing us) into a 1s hammer loop against
      // the public endpoint, because every attempt reaches `open` first.
      this.clearStableTimer();
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.ws === ws) this.reconnectAttempts = 0;
      }, STABLE_CONNECTION_MS);
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      this.lastActivityAt = Date.now();
      const data = event.data as string;
      // Chain onto the queue so events apply strictly in arrival order.
      this.queue = this.queue
        .then(() => this.handleMessage(data))
        .catch((err) => console.error('[Firehose] handler error:', err));
    });

    // Any control frame proves the socket is alive even when no documents flow.
    ws.addEventListener('ping', () => {
      this.lastActivityAt = Date.now();
    });
    ws.addEventListener('pong', () => {
      this.lastActivityAt = Date.now();
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      // Ignore the close of a socket we've already superseded (intentional
      // reconnect/stop sets this.ws elsewhere first).
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.clearPingTimer();
      this.clearStableTimer();
      // Always say *why*. Jetstream reports rejected subscriber options as a
      // normal (1000) close with the reason in the payload, so without this a
      // fatal misconfiguration is indistinguishable from an idle disconnect.
      console.warn(
        `[Firehose] socket closed: code=${event?.code ?? 'n/a'} ` +
          `reason=${JSON.stringify(event?.reason ?? '')}`
      );
      this.flushCursor();
      this.scheduleReconnect();
    });

    ws.addEventListener('error', (err) => {
      console.error('[Firehose] socket error:', (err as ErrorEvent)?.message ?? 'unknown');
      // A 'close' event follows and drives the reconnect.
    });
  }

  private async handleMessage(data: string): Promise<void> {
    let event: JetstreamEvent;
    try {
      event = JSON.parse(data) as JetstreamEvent;
    } catch {
      return;
    }

    if (event.time_us) this.lastCursor = event.time_us.toString();
    if (event.kind === 'commit') this.lastEventAt = Date.now();

    if (event.kind === 'commit' && event.commit?.collection === DOCUMENT_COLLECTION) {
      try {
        await this.applyDocumentEvent(event);
      } catch (err) {
        console.error(`[Firehose] failed to apply event for ${event.did}:`, err);
        this.markAuthorForRelist(event.did);
      }
    }
  }

  private markAuthorForRelist(did: string): void {
    this.db.run('UPDATE document_cache SET listed_at = 0 WHERE did = ?', [did]);
  }

  /** Ping the server every PING_INTERVAL_MS and force a reconnect if no frame
   *  has come back within PING_TIMEOUT_MS — the only liveness signal that holds
   *  up when the (DID-filtered) stream is legitimately silent. */
  private startPingTimer(ws: WebSocket): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) {
        this.clearPingTimer();
        return;
      }
      const idle = Date.now() - this.lastActivityAt;
      if (idle > PING_TIMEOUT_MS) {
        console.warn(
          `[Firehose] no frames for ${Math.round(idle / 1000)}s; socket stalled, reconnecting`
        );
        this.reconnect();
        return;
      }
      try {
        // `.ping()` is a Bun WebSocket extension, absent from the DOM lib type.
        (ws as WebSocket & { ping: () => void }).ping();
      } catch (err) {
        console.error('[Firehose] ping failed:', err);
        this.reconnect();
      }
    }, PING_INTERVAL_MS);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private reconnect(): void {
    this.closeSocket();
    this.connect();
  }

  private closeSocket(): void {
    this.clearPingTimer();
    this.clearStableTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null; // null first so the close handler treats this as superseded
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.sentDids.clear();
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.subscribedDids.size === 0) return; // wait for reconcile to find authors
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
    console.log(`[Firehose] reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // --- Cursor persistence -----------------------------------------------------

  private readCursor(): string | null {
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM sync_state WHERE key = ?')
      .get(CURSOR_KEY);
    return row?.value ?? null;
  }

  private flushCursor(): void {
    if (!this.lastCursor) return;
    this.db.run(
      `INSERT INTO sync_state (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [CURSOR_KEY, this.lastCursor]
    );
  }
}
