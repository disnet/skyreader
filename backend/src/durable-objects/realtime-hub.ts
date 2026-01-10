import type { Env, Session } from '../types';

interface ConnectedClient {
  socket: WebSocket;
  did: string;
  followingDids: Set<string>;
  subscribedFeedUrls: Set<string>;
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
  itemUrl: string;
  itemTitle?: string;
  itemDescription?: string;
  itemImage?: string;
  note?: string;
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
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Start heartbeat interval
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeats();
      this.cleanupStaleConnections();
    }, 30000);

    // Use hibernation API for WebSocket connections
    this.state.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment() as ConnectedClient | null;
      if (attachment) {
        this.clients.set(ws, {
          ...attachment,
          socket: ws,
          followingDids: new Set(attachment.followingDids),
          subscribedFeedUrls: new Set(attachment.subscribedFeedUrls),
        });
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal broadcast endpoint (called by JetstreamConsumer and scheduled-feeds)
    if (url.pathname === '/broadcast') {
      const message = await request.json() as RealtimeMessage;
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

    // Load user's follows and subscriptions
    const [follows, subscriptions] = await Promise.all([
      this.getUserFollows(session.did),
      this.getUserSubscriptions(session.did),
    ]);

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket with hibernation support
    this.state.acceptWebSocket(server);

    const clientData: ConnectedClient = {
      socket: server,
      did: session.did,
      followingDids: new Set(follows),
      subscribedFeedUrls: new Set(subscriptions),
      lastHeartbeat: Date.now(),
    };

    // Store attachment for hibernation
    server.serializeAttachment({
      did: clientData.did,
      followingDids: Array.from(clientData.followingDids),
      subscribedFeedUrls: Array.from(clientData.subscribedFeedUrls),
      lastHeartbeat: clientData.lastHeartbeat,
    });

    this.clients.set(server, clientData);

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
          followingDids: Array.from(client.followingDids),
          subscribedFeedUrls: Array.from(client.subscribedFeedUrls),
          lastHeartbeat: client.lastHeartbeat,
        });
      } else if (data.type === 'subscribe_feed') {
        client.subscribedFeedUrls.add(data.payload.feedUrl);
        ws.serializeAttachment({
          did: client.did,
          followingDids: Array.from(client.followingDids),
          subscribedFeedUrls: Array.from(client.subscribedFeedUrls),
          lastHeartbeat: client.lastHeartbeat,
        });
      } else if (data.type === 'unsubscribe_feed') {
        client.subscribedFeedUrls.delete(data.payload.feedUrl);
        ws.serializeAttachment({
          did: client.did,
          followingDids: Array.from(client.followingDids),
          subscribedFeedUrls: Array.from(client.subscribedFeedUrls),
          lastHeartbeat: client.lastHeartbeat,
        });
      }
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
      // Only send to users who follow the author
      for (const [ws, client] of this.clients) {
        if (client.followingDids.has(payload.authorDid)) {
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
      // Only send to users subscribed to this feed
      for (const [ws, client] of this.clients) {
        if (client.subscribedFeedUrls.has(payload.feedUrl)) {
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
    const sessionData = await this.env.SESSION_CACHE.get(`session:${sessionId}`);
    if (!sessionData) return null;
    return JSON.parse(sessionData) as Session;
  }

  private async getUserFollows(did: string): Promise<string[]> {
    try {
      const result = await this.env.DB.prepare(
        'SELECT following_did FROM follows_cache WHERE follower_did = ?'
      ).bind(did).all<{ following_did: string }>();

      return result.results.map(r => r.following_did);
    } catch (error) {
      console.error('Failed to get user follows:', error);
      return [];
    }
  }

  private async getUserSubscriptions(did: string): Promise<string[]> {
    try {
      const result = await this.env.DB.prepare(
        'SELECT feed_url FROM subscriptions_cache WHERE user_did = ?'
      ).bind(did).all<{ feed_url: string }>();

      return result.results.map(r => r.feed_url);
    } catch (error) {
      console.error('Failed to get user subscriptions:', error);
      return [];
    }
  }
}
