import type { DiscoverUser, FeedItem, ParsedFeed, SocialShare, User } from '$lib/types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787';

class ApiClient {
	private onUnauthorized: (() => void) | null = null;

	// Set callback for when 401 is received (session invalid)
	setOnUnauthorized(callback: () => void) {
		this.onUnauthorized = callback;
	}

	private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
		const headers: HeadersInit = {
			'Content-Type': 'application/json',
			...options.headers,
		};

		// Session is managed via HTTP-only cookies, no Authorization header needed
		const response = await fetch(`${API_BASE}${path}`, {
			...options,
			headers,
			credentials: 'include',
		});

		if (!response.ok) {
			// Handle 401 - session is invalid/expired
			if (response.status === 401) {
				console.warn('Session expired or invalid, logging out...');
				if (this.onUnauthorized) {
					this.onUnauthorized();
				}
				throw new Error('Session expired');
			}

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

	async getMe(): Promise<User> {
		return this.fetch('/api/auth/me');
	}

	// Feeds (V2 - via Fly.io proxy)
	async fetchFeedV2(url: string, sinceGuids?: string[], limit?: number): Promise<ParsedFeed> {
		const params = new URLSearchParams({ url });
		if (sinceGuids && sinceGuids.length > 0) {
			params.set('since_guids', sinceGuids.join(','));
		}
		if (limit) {
			params.set('limit', limit.toString());
		}
		return this.fetch(`/api/v2/feeds/fetch?${params}`);
	}

	async fetchFeedsBatchV2(
		feeds: Array<{ url: string; since_guids?: string[]; limit?: number }>
	): Promise<{
		feeds: Record<
			string,
			{
				title: string;
				description?: string;
				siteUrl?: string;
				imageUrl?: string;
				items: FeedItem[];
				status: 'ready' | 'error';
				error?: string;
				errorCount?: number;
				nextRetryAt?: number;
				lastFetchedAt?: number;
			}
		>;
	}> {
		return this.fetch('/api/v2/feeds/batch', {
			method: 'POST',
			body: JSON.stringify({ feeds }),
		});
	}

	async discoverFeedsV2(url: string): Promise<{ feeds: string[] }> {
		return this.fetch(`/api/v2/feeds/discover?url=${encodeURIComponent(url)}`);
	}

	// Social
	async getSocialFeed(
		cursor?: string,
		limit = 50
	): Promise<{
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

	async getFollowedUsers(
		cursor?: string,
		limit?: number
	): Promise<{
		users: Array<{
			did: string;
			source: 'bluesky' | 'inapp' | 'both';
		}>;
		cursor: string | null;
	}> {
		const params = new URLSearchParams();
		if (cursor) params.set('cursor', cursor);
		if (limit) params.set('limit', limit.toString());
		const query = params.toString();
		return this.fetch(`/api/social/following${query ? `?${query}` : ''}`);
	}

	async getDiscoverUsers(limit = 20): Promise<{ users: DiscoverUser[] }> {
		const params = new URLSearchParams({ limit: limit.toString() });
		return this.fetch(`/api/discover?${params}`);
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

	// User's own shares
	async getMyShares(): Promise<{
		shares: Array<{
			recordUri: string;
			recordCid: string;
			feedUrl?: string;
			articleGuid?: string;
			articleUrl: string;
			articleTitle?: string;
			articleAuthor?: string;
			articleDescription?: string;
			articleImage?: string;
			articlePublishedAt?: string;
			note?: string;
			createdAt: string;
		}>;
	}> {
		return this.fetch('/api/shares/my');
	}

	// Subscriptions
	async createSubscription(data: {
		rkey: string;
		feedUrl: string;
		title?: string;
		siteUrl?: string;
		category?: string;
		tags?: string[];
		source?: string;
	}): Promise<{ rkey: string; uri: string }> {
		return this.fetch('/api/subscriptions', {
			method: 'POST',
			body: JSON.stringify(data),
		});
	}

	async deleteSubscription(rkey: string): Promise<{ success: boolean }> {
		return this.fetch(`/api/subscriptions/${rkey}`, {
			method: 'DELETE',
		});
	}

	async bulkCreateSubscriptions(
		subscriptions: Array<{
			rkey: string;
			feedUrl: string;
			title?: string;
			siteUrl?: string;
			category?: string;
			source?: string;
		}>
	): Promise<{ results: Array<{ rkey: string; uri: string }> }> {
		return this.fetch('/api/subscriptions/bulk', {
			method: 'POST',
			body: JSON.stringify({ subscriptions }),
		});
	}

	async bulkDeleteSubscriptions(rkeys: string[]): Promise<{ success: boolean; deleted: number }> {
		return this.fetch('/api/subscriptions/bulk-delete', {
			method: 'POST',
			body: JSON.stringify({ rkeys }),
		});
	}

	// Follows
	async followUser(rkey: string, subject: string): Promise<{ rkey: string; uri: string }> {
		return this.fetch('/api/social/follow', {
			method: 'POST',
			body: JSON.stringify({ rkey, subject }),
		});
	}

	async unfollowUser(rkey: string): Promise<{ success: boolean }> {
		return this.fetch(`/api/social/follow/${rkey}`, {
			method: 'DELETE',
		});
	}

	async listInAppFollows(): Promise<{
		follows: Array<{
			rkey: string;
			did: string;
			handle?: string;
			displayName?: string;
			avatarUrl?: string;
			createdAt: number;
		}>;
	}> {
		return this.fetch('/api/social/follows');
	}

	// Shares
	async createShare(data: {
		rkey: string;
		itemUrl: string;
		feedUrl?: string;
		itemGuid?: string;
		itemTitle?: string;
		itemAuthor?: string;
		itemDescription?: string;
		content?: string;
		itemImage?: string;
		itemPublishedAt?: string;
		note?: string;
		tags?: string[];
	}): Promise<{ rkey: string; uri: string }> {
		return this.fetch('/api/shares', {
			method: 'POST',
			body: JSON.stringify(data),
		});
	}

	async deleteShare(rkey: string): Promise<{ success: boolean }> {
		return this.fetch(`/api/shares/${rkey}`, {
			method: 'DELETE',
		});
	}

	// Share read positions
	async markShareAsRead(data: {
		rkey: string;
		shareUri: string;
		shareAuthorDid: string;
		itemUrl?: string;
		itemTitle?: string;
	}): Promise<{ rkey: string; uri: string }> {
		return this.fetch('/api/social/share-read', {
			method: 'POST',
			body: JSON.stringify(data),
		});
	}

	async markShareAsUnread(rkey: string): Promise<{ success: boolean }> {
		return this.fetch(`/api/social/share-read/${rkey}`, {
			method: 'DELETE',
		});
	}

	async getShareReadPositions(): Promise<{
		positions: Array<{
			rkey: string;
			shareUri: string;
			shareAuthorDid: string;
			itemUrl: string | null;
			itemTitle: string | null;
			readAt: string;
		}>;
	}> {
		return this.fetch('/api/social/share-read');
	}

	// List records (still used for syncFromBackend)
	async listRecords<T>(collection: string): Promise<{
		records: Array<{ uri: string; cid: string; value: T }>;
	}> {
		return this.fetch(`/api/records/list?collection=${encodeURIComponent(collection)}`);
	}

	// Reading (read positions)
	async getReadPositions(): Promise<{
		positions: Array<{
			item_guid: string;
			item_url: string | null;
			item_title: string | null;
			starred: number;
			read_at: number;
			rkey: string;
		}>;
	}> {
		return this.fetch('/api/reading/positions');
	}

	async markAsRead(data: {
		itemGuid: string;
		itemUrl?: string;
		itemTitle?: string;
		starred?: boolean;
	}): Promise<{ success: boolean; rkey?: string; alreadyRead?: boolean }> {
		return this.fetch('/api/reading/mark-read', {
			method: 'POST',
			body: JSON.stringify(data),
		});
	}

	async markAsUnread(itemGuid: string): Promise<{ success: boolean }> {
		return this.fetch('/api/reading/mark-unread', {
			method: 'POST',
			body: JSON.stringify({ itemGuid }),
		});
	}

	async toggleStar(
		itemGuid: string,
		starred: boolean,
		itemUrl?: string,
		itemTitle?: string
	): Promise<{ success: boolean; starred: boolean }> {
		return this.fetch('/api/reading/toggle-star', {
			method: 'POST',
			body: JSON.stringify({ itemGuid, starred, itemUrl, itemTitle }),
		});
	}

	async markAsReadBulk(
		items: Array<{
			itemGuid: string;
			itemUrl?: string;
			itemTitle?: string;
		}>
	): Promise<{ success: boolean; marked: number; skipped: number }> {
		return this.fetch('/api/reading/mark-read-bulk', {
			method: 'POST',
			body: JSON.stringify({ items }),
		});
	}
}

export const api = new ApiClient();
