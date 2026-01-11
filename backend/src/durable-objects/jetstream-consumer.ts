import type { Env } from '../types';

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
      // For shares (com.at-rss.social.share)
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
      // For follows (app.bsky.graph.follow)
      subject?: string;
    };
    cid?: string;
  };
}

export class JetstreamConsumer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private ws: WebSocket | null = null;
  private reconnectTimeout: number | null = null;
  private watchedDids: Set<string> = new Set();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Load watched DIDs and start connection when instantiated
    this.state.blockConcurrencyWhile(async () => {
      await this.loadWatchedDids();
      await this.connect();
      // Schedule alarm to keep DO alive and monitor connection
      await this.state.storage.setAlarm(Date.now() + 30000);
    });
  }

  // Keep DO alive and ensure Jetstream connection stays up
  async alarm(): Promise<void> {
    // Reconnect if needed
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('Alarm: WebSocket not connected, reconnecting...');
      await this.connect();
    }

    // Always reschedule to stay alive
    await this.state.storage.setAlarm(Date.now() + 30000);
  }

  private async loadWatchedDids(): Promise<void> {
    // Try to load from DO storage first
    const stored = await this.state.storage.get<string[]>('watchedDids');

    if (stored && stored.length > 0) {
      this.watchedDids = new Set(stored);
      console.log(`Loaded ${this.watchedDids.size} watched DIDs from storage`);
    } else {
      // First start - load all existing users from D1
      const users = await this.env.DB.prepare(
        'SELECT did FROM users LIMIT 10000'
      ).all<{ did: string }>();

      if (users.results && users.results.length > 0) {
        this.watchedDids = new Set(users.results.map(u => u.did));
        await this.state.storage.put('watchedDids', [...this.watchedDids]);
        console.log(`Initialized ${this.watchedDids.size} watched DIDs from D1`);
      }
    }
  }

  // Add a DID to watch list and reconnect with cursor to avoid gaps
  async addWatchedDid(did: string): Promise<void> {
    if (this.watchedDids.has(did)) return;

    this.watchedDids.add(did);
    await this.state.storage.put('watchedDids', [...this.watchedDids]);
    console.log(`Added DID to watch list: ${did} (total: ${this.watchedDids.size})`);

    // Close existing connection and reconnect with updated DID list
    // Cursor ensures we don't miss any events during reconnection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    await this.connect();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      return new Response(
        JSON.stringify({
          connected: this.ws?.readyState === WebSocket.OPEN,
          watchedDids: this.watchedDids.size,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/reconnect') {
      await this.connect();
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/register-did' && request.method === 'POST') {
      try {
        const { did } = await request.json() as { did: string };
        if (!did) {
          return new Response(JSON.stringify({ error: 'Missing did' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        await this.addWatchedDid(did);
        return new Response(JSON.stringify({ success: true, totalWatched: this.watchedDids.size }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.error('Failed to register DID:', error);
        return new Response(JSON.stringify({ error: 'Failed to register DID' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Not found', { status: 404 });
  }

  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      // Get last cursor from D1
      const cursorResult = await this.env.DB.prepare(
        'SELECT value FROM sync_state WHERE key = ?'
      ).bind('jetstream_cursor').first<{ value: string }>();

      const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
      wsUrl.searchParams.append('wantedCollections', 'com.at-rss.social.share');
      wsUrl.searchParams.append('wantedCollections', 'app.bsky.graph.follow');

      // Add watched DIDs for filtering (up to 10k supported)
      for (const did of this.watchedDids) {
        wsUrl.searchParams.append('wantedDids', did);
      }

      if (cursorResult?.value) {
        // Subtract 5 seconds (in microseconds) to ensure we catch everything during reconnects
        const cursorWithBuffer = BigInt(cursorResult.value) - BigInt(5_000_000);
        wsUrl.searchParams.set('cursor', cursorWithBuffer.toString());
      }

      console.log(`Connecting to Jetstream with ${this.watchedDids.size} watched DIDs`);

      // Create WebSocket connection
      const ws = new WebSocket(wsUrl.toString());

      ws.addEventListener('open', () => {
        console.log('Jetstream connected');
      });

      ws.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data as string) as JetstreamEvent;
          await this.handleEvent(data);
        } catch (error) {
          console.error('Error handling Jetstream event:', error);
        }
      });

      ws.addEventListener('close', () => {
        console.log('Jetstream disconnected');
        this.ws = null;
        // Schedule reconnect
        this.scheduleReconnect();
      });

      ws.addEventListener('error', (error) => {
        console.error('Jetstream error:', error);
        ws.close();
      });

      this.ws = ws;
    } catch (error) {
      console.error('Failed to connect to Jetstream:', error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return;
    }

    // Reconnect after 5 seconds
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 5000) as unknown as number;
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
      console.error('Failed to notify RealtimeHub:', error);
    }
  }

  private async handleEvent(event: JetstreamEvent): Promise<void> {
    if (event.kind !== 'commit' || !event.commit) {
      return;
    }

    const { did, commit } = event;
    const { operation, collection, rkey, record, cid } = commit;

    // Route to appropriate handler based on collection
    if (collection === 'app.bsky.graph.follow') {
      await this.handleFollowEvent(event);
      return;
    }

    if (collection !== 'com.at-rss.social.share') {
      return;
    }

    const recordUri = `at://${did}/${collection}/${rkey}`;

    try {
      if (operation === 'create' && record && cid) {
        // Insert share into D1
        await this.env.DB.prepare(`
          INSERT OR REPLACE INTO shares
          (author_did, record_uri, record_cid, feed_url, item_url, item_title,
           item_author, item_description, item_image, item_guid, item_published_at,
           note, tags, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          record.createdAt ? new Date(record.createdAt).getTime() : Date.now()
        ).run();

        // Ensure user exists
        await this.env.DB.prepare(`
          INSERT OR IGNORE INTO users (did, handle, pds_url)
          VALUES (?, ?, '')
        `).bind(did, did).run();

        // Notify RealtimeHub of new share
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
            createdAt: record.createdAt,
          },
        });
      } else if (operation === 'delete') {
        await this.env.DB.prepare(
          'DELETE FROM shares WHERE record_uri = ?'
        ).bind(recordUri).run();
      }

      // Update cursor
      await this.env.DB.prepare(
        'INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())'
      ).bind('jetstream_cursor', event.time_us.toString()).run();
    } catch (error) {
      console.error('Error processing share event:', error);
    }
  }

  private async handleFollowEvent(event: JetstreamEvent): Promise<void> {
    const { did, commit } = event;
    if (!commit) return;

    const { operation, rkey, record } = commit;

    try {
      if (operation === 'create' && record?.subject) {
        // User followed someone - add to follows_cache
        await this.env.DB.prepare(`
          INSERT OR IGNORE INTO follows_cache (follower_did, following_did, rkey)
          VALUES (?, ?, ?)
        `).bind(did, record.subject, rkey).run();

        // Update last_synced_at for this user
        await this.env.DB.prepare(
          'UPDATE users SET last_synced_at = unixepoch() WHERE did = ?'
        ).bind(did).run();

        console.log(`Follow: ${did} -> ${record.subject}`);

      } else if (operation === 'delete') {
        // User unfollowed someone - remove from follows_cache using rkey
        await this.env.DB.prepare(
          'DELETE FROM follows_cache WHERE follower_did = ? AND rkey = ?'
        ).bind(did, rkey).run();

        console.log(`Unfollow: ${did} (rkey: ${rkey})`);
      }

      // Update cursor
      await this.env.DB.prepare(
        'INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())'
      ).bind('jetstream_cursor', event.time_us.toString()).run();

    } catch (error) {
      console.error('Error processing follow event:', error);
    }
  }
}
