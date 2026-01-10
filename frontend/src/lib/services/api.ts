import type { ParsedFeed, SocialShare } from '$lib/types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787';

class ApiClient {
  private sessionId: string | null = null;

  setSession(sessionId: string | null) {
    this.sessionId = sessionId;
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.sessionId) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.sessionId}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error((error as { error: string }).error || `HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  // Auth
  async login(handle: string, returnUrl?: string): Promise<{ authUrl: string }> {
    const params = new URLSearchParams({ handle });
    if (returnUrl) params.set('returnUrl', returnUrl);
    return this.fetch(`/api/auth/login?${params}`);
  }

  async logout(): Promise<void> {
    await this.fetch('/api/auth/logout', { method: 'POST' });
  }

  // Feeds
  async fetchFeed(url: string, force = false): Promise<ParsedFeed> {
    const params = new URLSearchParams({ url });
    if (force) params.set('force', 'true');
    return this.fetch(`/api/feeds/fetch?${params}`);
  }

  async discoverFeeds(url: string): Promise<{ feeds: string[] }> {
    return this.fetch(`/api/feeds/discover?url=${encodeURIComponent(url)}`);
  }

  // Social
  async getSocialFeed(cursor?: string, limit = 50): Promise<{
    shares: SocialShare[];
    cursor: string | null;
  }> {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (cursor) params.set('cursor', cursor);
    return this.fetch(`/api/social/feed?${params}`);
  }

  async syncFollows(): Promise<{ synced: number }> {
    return this.fetch('/api/social/sync-follows', { method: 'POST' });
  }

  async getPopularShares(
    period: 'day' | 'week' | 'month' = 'week',
    cursor?: string,
    limit = 50
  ): Promise<{
    shares: (SocialShare & { shareCount: number })[];
    cursor: string | null;
  }> {
    const params = new URLSearchParams({ period, limit: limit.toString() });
    if (cursor) params.set('cursor', cursor);
    return this.fetch(`/api/social/popular?${params}`);
  }

  // Record sync
  async syncRecord(request: {
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    record?: Record<string, unknown>;
  }): Promise<{ uri?: string; cid?: string }> {
    return this.fetch('/api/records/sync', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
}

export const api = new ApiClient();
