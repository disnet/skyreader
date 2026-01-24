/**
 * Feed Status Store - Tracks per-feed error state and circuit breaker status
 *
 * Integrates with the V2 batch API response format which includes:
 * - status: 'ready' | 'error'
 * - error?: string
 * - errorCount?: number
 * - nextRetryAt?: number (Unix timestamp)
 */

export type FeedStatusType = 'ready' | 'pending' | 'error' | 'circuit-open';
export type ErrorType = 'transient' | 'permanent';

export interface FeedStatus {
	status: FeedStatusType;
	errorCount: number;
	errorMessage?: string;
	errorType?: ErrorType;
	nextRetryAt?: number; // Unix timestamp in ms
	lastFetchedAt?: number;
	lastCheckedAt?: number;
}

// Error codes that indicate permanent failures (feed is gone/unauthorized)
const PERMANENT_ERROR_PATTERNS = [
	'401',
	'403',
	'404',
	'410',
	'not found',
	'unauthorized',
	'forbidden',
	'gone',
];

// Error codes that indicate transient failures (server issues, rate limiting)
const TRANSIENT_ERROR_PATTERNS = ['429', '5', 'timeout', 'network', 'econnrefused', 'dns'];

/**
 * Classify an error message as transient or permanent
 */
function classifyError(errorMessage?: string): ErrorType {
	if (!errorMessage) return 'transient';
	const lower = errorMessage.toLowerCase();

	for (const pattern of PERMANENT_ERROR_PATTERNS) {
		if (lower.includes(pattern)) return 'permanent';
	}

	for (const pattern of TRANSIENT_ERROR_PATTERNS) {
		if (lower.includes(pattern)) return 'transient';
	}

	// Default to transient for unknown errors
	return 'transient';
}

/**
 * V2 API batch response format for a single feed
 */
export interface V2FeedResult {
	title: string;
	description?: string;
	siteUrl?: string;
	imageUrl?: string;
	items: Array<{
		guid: string;
		url: string;
		title: string;
		author?: string;
		content?: string;
		summary?: string;
		imageUrl?: string;
		publishedAt: string;
	}>;
	status: 'ready' | 'error';
	error?: string;
	errorCount?: number;
	nextRetryAt?: number;
	lastFetchedAt?: number;
}

function createFeedStatusStore() {
	let statuses = $state<Map<string, FeedStatus>>(new Map());

	// Derived: feeds with errors
	let errorFeeds = $derived.by(() => {
		const errors: Array<{ feedUrl: string; status: FeedStatus }> = [];
		for (const [feedUrl, status] of statuses) {
			if (status.status === 'error' || status.status === 'circuit-open') {
				errors.push({ feedUrl, status });
			}
		}
		return errors;
	});

	// Derived: feeds that can be fetched (not in circuit-breaker cooldown)
	let fetchableFeeds = $derived.by(() => {
		const now = Date.now();
		const fetchable: string[] = [];
		for (const [feedUrl, status] of statuses) {
			if (status.status === 'circuit-open' && status.nextRetryAt && status.nextRetryAt > now) {
				continue; // Skip feeds in cooldown
			}
			fetchable.push(feedUrl);
		}
		return fetchable;
	});

	// Derived: feeds with permanent errors
	let permanentErrorFeeds = $derived.by(() => {
		const permanent: Array<{ feedUrl: string; status: FeedStatus }> = [];
		for (const [feedUrl, status] of statuses) {
			if (status.errorType === 'permanent') {
				permanent.push({ feedUrl, status });
			}
		}
		return permanent;
	});

	/**
	 * Update status for a feed from V2 batch response
	 */
	function updateFromV2Result(feedUrl: string, result: V2FeedResult): void {
		const now = Date.now();

		if (result.status === 'ready') {
			statuses.set(feedUrl, {
				status: 'ready',
				errorCount: 0,
				lastFetchedAt: result.lastFetchedAt || now,
				lastCheckedAt: now,
			});
		} else {
			// Error response
			const errorType = classifyError(result.error);
			const isCircuitOpen = result.nextRetryAt && result.nextRetryAt > now / 1000;

			statuses.set(feedUrl, {
				status: isCircuitOpen ? 'circuit-open' : 'error',
				errorCount: result.errorCount || 1,
				errorMessage: result.error,
				errorType,
				nextRetryAt: result.nextRetryAt ? result.nextRetryAt * 1000 : undefined, // Convert to ms
				lastFetchedAt: result.lastFetchedAt,
				lastCheckedAt: now,
			});
		}

		// Trigger reactivity
		statuses = new Map(statuses);
	}

	/**
	 * Mark a feed as pending (initial state for new subscriptions)
	 */
	function markPending(feedUrl: string): void {
		statuses.set(feedUrl, {
			status: 'pending',
			errorCount: 0,
			lastCheckedAt: Date.now(),
		});
		statuses = new Map(statuses);
	}

	/**
	 * Mark a feed as ready
	 */
	function markReady(feedUrl: string): void {
		statuses.set(feedUrl, {
			status: 'ready',
			errorCount: 0,
			lastFetchedAt: Date.now(),
			lastCheckedAt: Date.now(),
		});
		statuses = new Map(statuses);
	}

	/**
	 * Mark a feed as having an error
	 */
	function markError(feedUrl: string, errorMessage: string): void {
		const existing = statuses.get(feedUrl);
		const errorType = classifyError(errorMessage);

		statuses.set(feedUrl, {
			status: 'error',
			errorCount: (existing?.errorCount || 0) + 1,
			errorMessage,
			errorType,
			lastFetchedAt: existing?.lastFetchedAt,
			lastCheckedAt: Date.now(),
		});
		statuses = new Map(statuses);
	}

	/**
	 * Clear status for a feed
	 */
	function clearStatus(feedUrl: string): void {
		statuses.delete(feedUrl);
		statuses = new Map(statuses);
	}

	/**
	 * Clear all statuses
	 */
	function clearAll(): void {
		statuses = new Map();
	}

	/**
	 * Get status for a specific feed
	 */
	function getStatus(feedUrl: string): FeedStatus | undefined {
		return statuses.get(feedUrl);
	}

	/**
	 * Check if a feed can be fetched (not in circuit-breaker cooldown)
	 */
	function canFetch(feedUrl: string): boolean {
		const status = statuses.get(feedUrl);
		if (!status) return true;

		if (status.status === 'circuit-open' && status.nextRetryAt) {
			return Date.now() >= status.nextRetryAt;
		}

		return true;
	}

	/**
	 * Get human-readable status message for a feed
	 */
	function getStatusMessage(feedUrl: string): string {
		const status = statuses.get(feedUrl);
		if (!status) return '';

		switch (status.status) {
			case 'ready':
				return '';
			case 'pending':
				return 'Loading...';
			case 'error':
				if (status.errorType === 'permanent') {
					return 'Feed unavailable';
				}
				return 'Temporarily unavailable';
			case 'circuit-open':
				if (status.nextRetryAt) {
					const retryIn = Math.max(0, Math.ceil((status.nextRetryAt - Date.now()) / 60000));
					return `Retry in ${retryIn} min`;
				}
				return 'Temporarily unavailable';
			default:
				return '';
		}
	}

	/**
	 * Initialize statuses for a list of feed URLs (mark as pending)
	 */
	function initializeFeeds(feedUrls: string[]): void {
		for (const url of feedUrls) {
			if (!statuses.has(url)) {
				statuses.set(url, {
					status: 'pending',
					errorCount: 0,
					lastCheckedAt: Date.now(),
				});
			}
		}
		statuses = new Map(statuses);
	}

	return {
		get statuses() {
			return statuses;
		},
		get errorFeeds() {
			return errorFeeds;
		},
		get fetchableFeeds() {
			return fetchableFeeds;
		},
		get permanentErrorFeeds() {
			return permanentErrorFeeds;
		},
		updateFromV2Result,
		markPending,
		markReady,
		markError,
		clearStatus,
		clearAll,
		getStatus,
		canFetch,
		getStatusMessage,
		initializeFeeds,
	};
}

export const feedStatusStore = createFeedStatusStore();
