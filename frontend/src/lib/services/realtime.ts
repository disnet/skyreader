import { browser } from '$app/environment';

const API_BASE = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787';
const WS_BASE = API_BASE.replace(/^http/, 'ws');

export interface RealtimeMessage {
  type: 'connected' | 'heartbeat' | 'new_share' | 'new_articles';
  payload: unknown;
}

export interface NewSharePayload {
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

export interface NewArticlesPayload {
  feedUrl: string;
  feedTitle: string;
  newCount: number;
  timestamp: number;
}

type MessageHandler = (payload: unknown) => void;

class RealtimeService {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000; // 30 seconds max
  private baseReconnectDelay = 1000; // 1 second initial
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeartbeat = 0;
  private messageHandlers: Map<string, Set<MessageHandler>> = new Map();
  private connectionHandlers: Set<(connected: boolean) => void> = new Set();

  constructor() {
    if (browser) {
      // Handle visibility changes
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.connect();
        } else {
          this.disconnect();
        }
      });

      // Handle online/offline
      window.addEventListener('online', () => this.connect());
      window.addEventListener('offline', () => this.disconnect());
    }
  }

  setSession(sessionId: string | null): void {
    const wasConnected = this.isConnected();
    this.sessionId = sessionId;

    if (sessionId && !wasConnected && browser && document.visibilityState === 'visible') {
      this.connect();
    } else if (!sessionId && wasConnected) {
      this.disconnect();
    }
  }

  connect(): void {
    if (!browser || !this.sessionId || document.visibilityState !== 'visible') {
      return;
    }

    // Already connected or connecting
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.clearReconnectTimer();

    try {
      // Use subprotocol for authentication
      const url = `${WS_BASE}/api/realtime`;
      this.ws = new WebSocket(url, [`bearer-${this.sessionId}`]);

      this.ws.addEventListener('open', () => {
        console.log('Realtime connected');
        this.reconnectAttempts = 0;
        this.notifyConnectionHandlers(true);
      });

      this.ws.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data) as RealtimeMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse realtime message:', error);
        }
      });

      this.ws.addEventListener('close', (event) => {
        console.log('Realtime disconnected:', event.code, event.reason);
        this.ws = null;
        this.clearHeartbeatTimer();
        this.notifyConnectionHandlers(false);

        // Reconnect if we still have a session and tab is visible
        if (this.sessionId && document.visibilityState === 'visible') {
          this.scheduleReconnect();
        }
      });

      this.ws.addEventListener('error', (error) => {
        console.error('Realtime error:', error);
      });
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();

    if (this.ws) {
      this.ws.close(1000, 'User disconnected');
      this.ws = null;
    }

    this.notifyConnectionHandlers(false);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  on(type: string, handler: MessageHandler): () => void {
    let handlers = this.messageHandlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.messageHandlers.set(type, handlers);
    }
    handlers.add(handler);

    // Return unsubscribe function
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.messageHandlers.delete(type);
      }
    };
  }

  onConnectionChange(handler: (connected: boolean) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  private handleMessage(message: RealtimeMessage): void {
    if (message.type === 'heartbeat') {
      this.lastHeartbeat = Date.now();
      this.sendPong();
      this.scheduleHeartbeatCheck();
      return;
    }

    if (message.type === 'connected') {
      this.lastHeartbeat = Date.now();
      this.scheduleHeartbeatCheck();
    }

    // Notify handlers
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message.payload);
        } catch (error) {
          console.error(`Error in ${message.type} handler:`, error);
        }
      }
    }
  }

  private sendPong(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'pong' }));
    }
  }

  private scheduleHeartbeatCheck(): void {
    this.clearHeartbeatTimer();

    // If no heartbeat in 60 seconds, reconnect
    this.heartbeatTimer = setTimeout(() => {
      const timeSinceHeartbeat = Date.now() - this.lastHeartbeat;
      if (timeSinceHeartbeat > 60000) {
        console.log('Heartbeat timeout, reconnecting...');
        this.ws?.close(1000, 'Heartbeat timeout');
      }
    }, 60000);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to maxReconnectDelay
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;

    console.log(`Scheduling reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private notifyConnectionHandlers(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected);
      } catch (error) {
        console.error('Error in connection handler:', error);
      }
    }
  }
}

export const realtime = new RealtimeService();
