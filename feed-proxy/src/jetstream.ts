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
  recordToProxyDocument,
  MAX_DOCUMENTS_PER_AUTHOR,
  type DocumentRecord,
  type ProxyDocument,
} from './standard-site';

const DEFAULT_JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe';
const DOCUMENT_COLLECTION = 'site.standard.document';
const CURSOR_KEY = 'jetstream_cursor_documents';
// Jetstream accepts at most 10,000 wantedDids per connection. We're far under at
// any realistic scale; beyond this, DID-set sharding across connections is the
// follow-up (see plan). Until then we watch the most-recently-requested 10k and
// let the rest fall back to age-based refresh.
const MAX_WANTED_DIDS = 10_000;
const RECONNECT_MAX_MS = 30_000;

/** Status accessor handed to the serve path so it can trust the cache for
 *  authors the firehose is actively keeping fresh. */
export interface FirehoseStatus {
  healthy: boolean;
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
  private lastCursor: string | null = null;
  private lastEventAt = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
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
    return this.enabled && this.connected;
  }

  isSubscribed(did: string): boolean {
    return this.subscribedDids.has(did);
  }

  status(): FirehoseStatus {
    return { healthy: this.isHealthy(), isSubscribed: (did) => this.isSubscribed(did) };
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

    if (rows.length > MAX_WANTED_DIDS) {
      console.warn(
        `[Firehose] ${rows.length} active authors exceed wantedDids cap ${MAX_WANTED_DIDS}; ` +
          `watching the ${MAX_WANTED_DIDS} most recently requested ` +
          `(${rows.length - MAX_WANTED_DIDS} fall back to age-based refresh)`
      );
      return rows.slice(0, MAX_WANTED_DIDS).map((r) => r.did);
    }
    return rows.map((r) => r.did);
  }

  /** Recompute the active set; reconnect only if it actually changed (the
   *  wantedDids filter is fixed per-connection). Public for tests. */
  reconcile(): void {
    const next = new Set(this.computeActiveDids(Date.now()));
    if (setsEqual(next, this.subscribedDids)) {
      this.flushCursor();
      return;
    }
    this.subscribedDids = next;
    console.log(`[Firehose] active author set changed → ${next.size}`);
    this.flushCursor();
    if (!this.running) return;
    if (next.size === 0) {
      this.closeSocket();
      return;
    }
    this.reconnect();
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
      .query<
        { documents_json: string },
        [string]
      >('SELECT documents_json FROM document_cache WHERE did = ?')
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
      .query<
        { documents_json: string },
        [string]
      >('SELECT documents_json FROM document_cache WHERE did = ?')
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
    for (const did of this.subscribedDids) url.searchParams.append('wantedDids', did);
    if (this.lastCursor) url.searchParams.set('cursor', this.lastCursor);

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
      this.reconnectAttempts = 0;
      this.lastEventAt = Date.now();
      console.log(`[Firehose] connected, watching ${this.subscribedDids.size} author(s)`);
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as string;
      // Chain onto the queue so events apply strictly in arrival order.
      this.queue = this.queue
        .then(() => this.handleMessage(data))
        .catch((err) => console.error('[Firehose] handler error:', err));
    });

    ws.addEventListener('close', () => {
      // Ignore the close of a socket we've already superseded (intentional
      // reconnect/stop sets this.ws elsewhere first).
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
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
      }
    }
  }

  private reconnect(): void {
    this.closeSocket();
    this.connect();
  }

  private closeSocket(): void {
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
