import type { Env, Session } from '../types';

interface ConnectedClient {
  socket: WebSocket;
  did: string;
  lastHeartbeat: number;
}

// Minimal attachment data to stay under 2KB limit
interface WebSocketAttachment {
  did: string;
  lastHeartbeat: number;
}

interface RealtimeMessage {
  type: 'connected' | 'heartbeat' | 'new_share' | 'new_articles';
  payload: unknown;
}

interface NewSharePayload {
  authorDid: string;
  authorHandle?: string;
  authorDisplayName?: string;
  authorAvatar?: string;
  recordUri: string;
  feedUrl?: string;
  itemUrl: string;
  itemTitle?: string;
  itemDescription?: string;
  itemImage?: string;
  itemGuid?: string;
  itemPublishedAt?: string;
  note?: string;
  content?: string;
  createdAt: string;
}

interface NewArticlesPayload {
  feedUrl: string;
  feedTitle: string;
  newCount: number;
  timestamp: number;
}

export class RealtimeHub implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private clients: Map<WebSocket, ConnectedClient> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Restore WebSocket connections from hibernation
    this.state.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment() as WebSocketAttachment | null;
      if (attachment) {
        this.clients.set(ws, {
          socket: ws,
          did: attachment.did,
          lastHeartbeat: attachment.lastHeartbeat,
        });
      }
    });
  }

  // Use alarm() instead of setInterval for hibernation support
  async alarm(): Promise<void> {
    this.sendHeartbeats();
    this.cleanupStaleConnections();

    // Schedule next alarm only if there are connected clients
    if (this.clients.size > 0) {
      await this.state.storage.setAlarm(Date.now() + 30000);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal broadcast endpoint (called by JetstreamConsumer and scheduled-feeds)
    if (url.pathname === '/broadcast') {
      const message = await request.json() as RealtimeMessage;
      // Broadcast shares even without content - frontend can fall back to description or fetch on-demand
      await this.broadcast(message);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Status endpoint
    if (url.pathname === '/status') {
      return new Response(
        JSON.stringify({
          connectedClients: this.clients.size,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // WebSocket upgrade for client connections
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Extract session token from subprotocol or query param
    const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(p => p.trim()) || [];
    let sessionId: string | null = null;

    for (const protocol of protocols) {
      if (protocol.startsWith('bearer-')) {
        sessionId = protocol.substring(7);
        break;
      }
    }

    if (!sessionId) {
      sessionId = url.searchParams.get('token');
    }

    if (!sessionId) {
      return new Response('Missing session token', { status: 401 });
    }

    // Validate session
    const session = await this.getSession(sessionId);
    if (!session) {
      return new Response('Invalid session', { status: 401 });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket with hibernation support
    this.state.acceptWebSocket(server);

    const clientData: ConnectedClient = {
      socket: server,
      did: session.did,
      lastHeartbeat: Date.now(),
    };

    // Store minimal attachment for hibernation (follows are looked up dynamically)
    server.serializeAttachment({
      did: clientData.did,
      lastHeartbeat: clientData.lastHeartbeat,
    } as WebSocketAttachment);

    this.clients.set(server, clientData);

    // Start heartbeat alarm if this is the first client
    if (this.clients.size === 1) {
      await this.state.storage.setAlarm(Date.now() + 30000);
    }

    // Send connected message
    server.send(JSON.stringify({
      type: 'connected',
      payload: { timestamp: Date.now() },
    }));

    // Return response with matching subprotocol if used
    const responseHeaders: HeadersInit = { 'Content-Type': 'application/json' };
    if (protocols.length > 0) {
      responseHeaders['Sec-WebSocket-Protocol'] = protocols[0];
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: responseHeaders,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) return;

    try {
      const data = JSON.parse(message as string);

      if (data.type === 'pong') {
        client.lastHeartbeat = Date.now();
        ws.serializeAttachment({
          did: client.did,
          lastHeartbeat: client.lastHeartbeat,
        } as WebSocketAttachment);
      }
      // subscribe_feed and unsubscribe_feed messages are no longer needed
      // since we look up subscriptions dynamically from the database
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.clients.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.clients.delete(ws);
  }

  private async broadcast(message: RealtimeMessage): Promise<void> {
    if (message.type === 'new_share') {
      const payload = message.payload as NewSharePayload;
      // Get all users who follow the author
      const followers = await this.getFollowersOf(payload.authorDid);
      const followerSet = new Set(followers);

      // Only send to connected users who follow the author
      for (const [ws, client] of this.clients) {
        if (followerSet.has(client.did)) {
          try {
            ws.send(JSON.stringify(message));
          } catch (error) {
            console.error('Error sending to client:', error);
            this.clients.delete(ws);
          }
        }
      }
    } else if (message.type === 'new_articles') {
      const payload = message.payload as NewArticlesPayload;
      // Get all users subscribed to this feed
      const subscribers = await this.getSubscribersOf(payload.feedUrl);
      const subscriberSet = new Set(subscribers);

      // Only send to connected users subscribed to this feed
      for (const [ws, client] of this.clients) {
        if (subscriberSet.has(client.did)) {
          try {
            ws.send(JSON.stringify(message));
          } catch (error) {
            console.error('Error sending to client:', error);
            this.clients.delete(ws);
          }
        }
      }
    } else {
      // Broadcast to all clients
      for (const [ws] of this.clients) {
        try {
          ws.send(JSON.stringify(message));
        } catch (error) {
          console.error('Error sending to client:', error);
          this.clients.delete(ws);
        }
      }
    }
  }

  private sendHeartbeats(): void {
    const message = JSON.stringify({
      type: 'heartbeat',
      payload: { timestamp: Date.now() },
    });

    for (const [ws] of this.clients) {
      try {
        ws.send(message);
      } catch (error) {
        console.error('Error sending heartbeat:', error);
        this.clients.delete(ws);
      }
    }
  }

  private cleanupStaleConnections(): void {
    const now = Date.now();
    const timeout = 90000; // 90 seconds (3 missed heartbeats)

    for (const [ws, client] of this.clients) {
      if (now - client.lastHeartbeat > timeout) {
        try {
          ws.close(1000, 'Heartbeat timeout');
        } catch {
          // Ignore close errors
        }
        this.clients.delete(ws);
      }
    }
  }

  private async getSession(sessionId: string): Promise<Session | null> {
    const row = await this.env.DB.prepare(
      'SELECT * FROM sessions WHERE session_id = ? AND expires_at > ?'
    ).bind(sessionId, Date.now()).first<{
      did: string;
      handle: string;
      display_name: string | null;
      avatar_url: string | null;
      pds_url: string;
      access_token: string;
      refresh_token: string;
      dpop_private_key: string;
      expires_at: number;
    }>();

    if (!row) return null;

    return {
      did: row.did,
      handle: row.handle,
      displayName: row.display_name || undefined,
      avatarUrl: row.avatar_url || undefined,
      pdsUrl: row.pds_url,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      dpopPrivateKey: row.dpop_private_key,
      expiresAt: row.expires_at,
    };
  }

  private async getFollowersOf(authorDid: string): Promise<string[]> {
    try {
      // Get followers from both Bluesky follows and in-app follows
      const result = await this.env.DB.prepare(`
        SELECT follower_did FROM follows_cache WHERE following_did = ?
        UNION
        SELECT follower_did FROM inapp_follows WHERE following_did = ?
      `).bind(authorDid, authorDid).all<{ follower_did: string }>();

      return result.results.map(r => r.follower_did);
    } catch (error) {
      console.error('Failed to get followers:', error);
      return [];
    }
  }

  private async getSubscribersOf(feedUrl: string): Promise<string[]> {
    try {
      const result = await this.env.DB.prepare(
        'SELECT user_did FROM subscriptions_cache WHERE feed_url = ?'
      ).bind(feedUrl).all<{ user_did: string }>();

      return result.results.map(r => r.user_did);
    } catch (error) {
      console.error('Failed to get subscribers:', error);
      return [];
    }
  }
}
