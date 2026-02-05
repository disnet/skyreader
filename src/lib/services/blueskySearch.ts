import type { BlueskyProfile } from '$lib/types';

const BSKY_PUBLIC_API = 'https://public.api.bsky.app';

export interface BlueskySearchResult {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
}

/**
 * Search for Bluesky actors using the typeahead API.
 * Optimized for autocomplete with fast responses.
 *
 * @param query - Search query (must be at least 2 characters)
 * @param limit - Maximum number of results (default: 8)
 * @returns Array of search results
 */
export async function searchBlueskyActors(
	query: string,
	limit = 8
): Promise<BlueskySearchResult[]> {
	// Don't search for very short queries
	if (query.length < 2) {
		return [];
	}

	try {
		const params = new URLSearchParams({
			q: query,
			limit: String(limit),
		});

		const response = await fetch(
			`${BSKY_PUBLIC_API}/xrpc/app.bsky.actor.searchActorsTypeahead?${params.toString()}`
		);

		if (!response.ok) {
			console.warn(`Failed to search actors: ${response.status}`);
			return [];
		}

		const data = (await response.json()) as {
			actors: Array<{
				did: string;
				handle: string;
				displayName?: string;
				avatar?: string;
			}>;
		};

		return data.actors.map((actor) => ({
			did: actor.did,
			handle: actor.handle,
			displayName: actor.displayName,
			avatar: actor.avatar,
		}));
	} catch (error) {
		console.error('Error searching Bluesky actors:', error);
		return [];
	}
}

/**
 * Convert a search result to a BlueskyProfile for consistency with other services.
 */
export function searchResultToProfile(result: BlueskySearchResult): BlueskyProfile {
	return {
		did: result.did,
		handle: result.handle,
		displayName: result.displayName,
		avatar: result.avatar,
	};
}
