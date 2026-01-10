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
      itemUrl: string;
      itemTitle?: string;
      itemAuthor?: string;
      itemDescription?: string;
      itemImage?: string;
      note?: string;
      tags?: string[];
      createdAt: string;
    };
    cid?: string;
  };
}

export class JetstreamConsumer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private ws: WebSocket | null = null;
  private reconnectTimeout: number | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Start connection when instantiated
    this.state.blockConcurrencyWhile(async () => {
      await this.connect();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      return new Response(
        JSON.stringify({
          connected: this.ws?.readyState === WebSocket.OPEN,
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

      const cursor = cursorResult?.value;

      const wsUrl = new URL('wss://jetstream2.us-east.bsky.network/subscribe');
      wsUrl.searchParams.set('wantedCollections', 'com.at-rss.social.share');

      if (cursor) {
        wsUrl.searchParams.set('cursor', cursor);
      }

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

  private async handleEvent(event: JetstreamEvent): Promise<void> {
    if (event.kind !== 'commit' || !event.commit) {
      return;
    }

    const { did, commit } = event;
    const { operation, collection, rkey, record, cid } = commit;

    if (collection !== 'com.at-rss.social.share') {
      return;
    }

    const recordUri = `at://${did}/${collection}/${rkey}`;

    try {
      if (operation === 'create' && record && cid) {
        // Insert share into D1
        await this.env.DB.prepare(`
          INSERT OR REPLACE INTO shares
          (author_did, record_uri, record_cid, item_url, item_title,
           item_author, item_description, item_image, note, tags, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          did,
          recordUri,
          cid,
          record.itemUrl,
          record.itemTitle || null,
          record.itemAuthor || null,
          record.itemDescription || null,
          record.itemImage || null,
          record.note || null,
          record.tags ? JSON.stringify(record.tags) : null,
          new Date(record.createdAt).getTime()
        ).run();

        // Ensure user exists
        await this.env.DB.prepare(`
          INSERT OR IGNORE INTO users (did, handle, pds_url)
          VALUES (?, ?, '')
        `).bind(did, did).run();
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
}
