import { browser } from '$app/environment';
import { realtime, type NewArticlesPayload, type NewSharePayload } from '$lib/services/realtime';

interface RealtimeState {
  isConnected: boolean;
  newArticleFeeds: Map<string, { title: string; count: number }>;
  newShareCount: number;
}

function createRealtimeStore() {
  let state = $state<RealtimeState>({
    isConnected: false,
    newArticleFeeds: new Map(),
    newShareCount: 0,
  });

  // Track unsubscribe functions
  let unsubscribes: Array<() => void> = [];

  function initialize(): void {
    if (!browser) return;

    // Listen for connection changes
    unsubscribes.push(
      realtime.onConnectionChange((connected) => {
        state.isConnected = connected;
      })
    );

    // Listen for new articles
    unsubscribes.push(
      realtime.on('new_articles', (payload) => {
        const data = payload as NewArticlesPayload;
        const existing = state.newArticleFeeds.get(data.feedUrl);
        state.newArticleFeeds.set(data.feedUrl, {
          title: data.feedTitle,
          count: (existing?.count || 0) + data.newCount,
        });
        // Trigger reactivity by reassigning
        state.newArticleFeeds = new Map(state.newArticleFeeds);
      })
    );

    // Listen for new shares
    unsubscribes.push(
      realtime.on('new_share', (_payload) => {
        state.newShareCount++;
      })
    );
  }

  function cleanup(): void {
    for (const unsub of unsubscribes) {
      unsub();
    }
    unsubscribes = [];
  }

  function connect(sessionId: string): void {
    realtime.setSession(sessionId);
  }

  function disconnect(): void {
    realtime.setSession(null);
  }

  function clearArticleNotifications(feedUrl?: string): void {
    if (feedUrl) {
      state.newArticleFeeds.delete(feedUrl);
      state.newArticleFeeds = new Map(state.newArticleFeeds);
    } else {
      state.newArticleFeeds.clear();
      state.newArticleFeeds = new Map();
    }
  }

  function clearShareNotifications(): void {
    state.newShareCount = 0;
  }

  function getTotalNewArticleCount(): number {
    let total = 0;
    for (const info of state.newArticleFeeds.values()) {
      total += info.count;
    }
    return total;
  }

  // Initialize on creation
  initialize();

  return {
    get isConnected() {
      return state.isConnected;
    },
    get newArticleFeeds() {
      return state.newArticleFeeds;
    },
    get newShareCount() {
      return state.newShareCount;
    },
    get totalNewArticles() {
      return getTotalNewArticleCount();
    },
    connect,
    disconnect,
    clearArticleNotifications,
    clearShareNotifications,
    cleanup,
    // Expose the realtime service for direct event subscriptions
    on: realtime.on.bind(realtime),
  };
}

export const realtimeStore = createRealtimeStore();
