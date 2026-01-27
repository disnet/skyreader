import type { BlueskyProfile } from '$lib/types';

const BSKY_PUBLIC_API = 'https://public.api.bsky.app';
const BATCH_SIZE = 25; // Bluesky API limit
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedProfile {
	profile: BlueskyProfile;
	fetchedAt: number;
}

class ProfileService {
	private cache = new Map<string, CachedProfile>();
	private pendingFetches = new Map<string, Promise<BlueskyProfile | null>>();

	// Get a single profile (from cache or fetch)
	async getProfile(did: string): Promise<BlueskyProfile | null> {
		const cached = this.cache.get(did);
		if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
			return cached.profile;
		}

		// Check if there's already a pending request for this DID
		const pending = this.pendingFetches.get(did);
		if (pending) {
			return pending;
		}

		// Fetch single profile
		const promise = this.fetchAndCache(did);
		this.pendingFetches.set(did, promise);

		try {
			return await promise;
		} finally {
			this.pendingFetches.delete(did);
		}
	}

	// Get multiple profiles at once (batched)
	async getProfiles(dids: string[]): Promise<Map<string, BlueskyProfile>> {
		const results = new Map<string, BlueskyProfile>();
		const toFetch: string[] = [];
		const toAwait: Array<{ did: string; promise: Promise<BlueskyProfile | null> }> = [];

		// Check cache and pending requests first
		for (const did of dids) {
			const cached = this.cache.get(did);
			if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
				results.set(did, cached.profile);
			} else {
				const pending = this.pendingFetches.get(did);
				if (pending) {
					toAwait.push({ did, promise: pending });
				} else {
					toFetch.push(did);
				}
			}
		}

		// Wait for any pending requests
		await Promise.all(
			toAwait.map(async ({ did, promise }) => {
				const profile = await promise;
				if (profile) results.set(did, profile);
			})
		);

		if (toFetch.length === 0) {
			return results;
		}

		// Batch fetch missing profiles
		const fetched = await this.fetchBatch(toFetch);
		for (const [did, profile] of fetched) {
			results.set(did, profile);
		}

		return results;
	}

	// Prefetch profiles (fire and forget)
	prefetch(dids: string[]): void {
		const toFetch = dids.filter((did) => {
			// Skip if cached
			const cached = this.cache.get(did);
			if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
				return false;
			}
			// Skip if already being fetched
			if (this.pendingFetches.has(did)) {
				return false;
			}
			return true;
		});

		if (toFetch.length > 0) {
			this.fetchBatch(toFetch).catch((e) => console.error('Profile prefetch error:', e));
		}
	}

	private async fetchAndCache(did: string): Promise<BlueskyProfile | null> {
		try {
			const response = await fetch(
				`${BSKY_PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
			);

			if (!response.ok) {
				console.warn(`Failed to fetch profile for ${did}: ${response.status}`);
				return null;
			}

			const data = (await response.json()) as {
				did: string;
				handle: string;
				displayName?: string;
				avatar?: string;
			};

			const profile: BlueskyProfile = {
				did: data.did,
				handle: data.handle,
				displayName: data.displayName,
				avatar: data.avatar,
			};

			this.cache.set(did, { profile, fetchedAt: Date.now() });
			return profile;
		} catch (error) {
			console.error(`Error fetching profile for ${did}:`, error);
			return null;
		}
	}

	private async fetchBatch(dids: string[]): Promise<Map<string, BlueskyProfile>> {
		const results = new Map<string, BlueskyProfile>();

		// Create individual promises for each DID so other callers can await them
		const promises = new Map<string, { resolve: (p: BlueskyProfile | null) => void }>();
		for (const did of dids) {
			const promise = new Promise<BlueskyProfile | null>((resolve) => {
				promises.set(did, { resolve });
			});
			this.pendingFetches.set(did, promise);
		}

		try {
			// Batch in groups of 25
			for (let i = 0; i < dids.length; i += BATCH_SIZE) {
				const batch = dids.slice(i, i + BATCH_SIZE);
				const params = new URLSearchParams();
				batch.forEach((did) => params.append('actors', did));

				try {
					const response = await fetch(
						`${BSKY_PUBLIC_API}/xrpc/app.bsky.actor.getProfiles?${params.toString()}`
					);

					if (!response.ok) {
						console.warn(`Failed to batch fetch profiles: ${response.status}`);
						// Resolve all promises in this batch with null
						for (const did of batch) {
							promises.get(did)?.resolve(null);
						}
						continue;
					}

					const data = (await response.json()) as {
						profiles: Array<{
							did: string;
							handle: string;
							displayName?: string;
							avatar?: string;
						}>;
					};

					// Track which DIDs we got back
					const fetchedDids = new Set<string>();

					for (const p of data.profiles) {
						const profile: BlueskyProfile = {
							did: p.did,
							handle: p.handle,
							displayName: p.displayName,
							avatar: p.avatar,
						};
						this.cache.set(p.did, { profile, fetchedAt: Date.now() });
						results.set(p.did, profile);
						fetchedDids.add(p.did);
						promises.get(p.did)?.resolve(profile);
					}

					// Resolve any DIDs in the batch that weren't returned with null
					for (const did of batch) {
						if (!fetchedDids.has(did)) {
							promises.get(did)?.resolve(null);
						}
					}
				} catch (error) {
					console.error('Error batch fetching profiles:', error);
					// Resolve all promises in this batch with null
					for (const did of batch) {
						promises.get(did)?.resolve(null);
					}
				}
			}
		} finally {
			// Clean up pending fetches
			for (const did of dids) {
				this.pendingFetches.delete(did);
			}
		}

		return results;
	}

	// Clear cache (useful for testing or forced refresh)
	clearCache(): void {
		this.cache.clear();
	}
}

export const profileService = new ProfileService();
