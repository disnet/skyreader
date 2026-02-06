// Source key utilities for unified source filter model
// Format: "rss~{subscriptionId}", "{did}~shares", "{did}~documents"

const SEP = '~';

// --- Construction ---

export function rssSourceKey(subscriptionId: number): string {
	return `rss${SEP}${subscriptionId}`;
}

export function sharesSourceKey(did: string): string {
	return `${did}${SEP}shares`;
}

export function documentsSourceKey(did: string): string {
	return `${did}${SEP}documents`;
}

// --- Parsing ---

export interface ParsedSourceKey {
	kind: string; // 'rss', 'shares', 'documents', etc.
	id: string; // subscription ID for RSS, DID for account sources
}

export function parseSourceKey(key: string): ParsedSourceKey {
	const lastSep = key.lastIndexOf(SEP);
	if (lastSep === -1) return { kind: key, id: '' };

	const prefix = key.substring(0, lastSep);
	const suffix = key.substring(lastSep + 1);

	if (prefix === 'rss') {
		return { kind: 'rss', id: suffix };
	}
	// Account sources: "{did}~shares", "{did}~documents"
	return { kind: suffix, id: prefix };
}

// --- Type guards ---

export function isRssSource(key: string): boolean {
	return key.startsWith(`rss${SEP}`);
}

export function isSharesSource(key: string): boolean {
	return key.endsWith(`${SEP}shares`);
}

export function isDocumentsSource(key: string): boolean {
	return key.endsWith(`${SEP}documents`);
}

// --- Extractors ---

export function getRssSubscriptionId(key: string): number {
	const parsed = parseSourceKey(key);
	return parseInt(parsed.id, 10);
}

export function getSourceDid(key: string): string {
	return parseSourceKey(key).id;
}

// --- Account source kinds (for UI iteration) ---

export const ACCOUNT_SOURCE_KINDS = [
	{ kind: 'shares', label: 'Shares', keyFn: sharesSourceKey },
	{ kind: 'documents', label: 'Articles', keyFn: documentsSourceKey },
] as const;

// --- Legacy migration ---

export interface LegacyViewFields {
	showArticles?: boolean;
	showShares?: boolean;
	showDocuments?: boolean;
	feedMode?: 'none' | 'all' | 'include' | 'exclude';
	feedIds?: number[];
	accountMode?: 'none' | 'all' | 'include' | 'exclude';
	accountDids?: string[];
}

export interface MigratedSourceFilter {
	sourceMode: 'all' | 'include' | 'exclude';
	sourceKeys: string[];
}

/**
 * Convert legacy FilteredView fields to unified source filter.
 *
 * @param view - Legacy view fields
 * @param allSubIds - All current subscription IDs (needed for 'all' feed mode with account exclusions)
 * @param allDids - All current followed DIDs (needed for 'all' account mode with feed exclusions)
 */
export function migrateLegacyView(
	view: LegacyViewFields,
	allSubIds: number[],
	allDids: string[]
): MigratedSourceFilter {
	const {
		showArticles = true,
		showShares = true,
		showDocuments = true,
		feedMode = 'all',
		feedIds = [],
		accountMode = 'all',
		accountDids = [],
	} = view;

	// Effective modes (respect showArticles/showShares/showDocuments)
	const effFeedMode = !showArticles ? 'none' : feedMode;
	const effAccountMode = !showShares && !showDocuments ? 'none' : accountMode;

	// Both disabled → include mode with empty keys (shows nothing)
	if (effFeedMode === 'none' && effAccountMode === 'none') {
		return { sourceMode: 'include', sourceKeys: [] };
	}

	// Both "all" → truly all sources
	if (effFeedMode === 'all' && effAccountMode === 'all') {
		// But check if shares/documents are selectively disabled
		if (showShares && showDocuments) {
			return { sourceMode: 'all', sourceKeys: [] };
		}
		// Some account content types disabled → exclude those specific kinds for all DIDs
		const excludeKeys: string[] = [];
		for (const did of allDids) {
			if (!showShares) excludeKeys.push(sharesSourceKey(did));
			if (!showDocuments) excludeKeys.push(documentsSourceKey(did));
		}
		if (excludeKeys.length === 0) {
			return { sourceMode: 'all', sourceKeys: [] };
		}
		return { sourceMode: 'exclude', sourceKeys: excludeKeys };
	}

	// If one dimension is "all" and the other uses include/exclude, we need to
	// convert to a single include or exclude list.

	// Strategy: prefer include mode when possible (usually more specific)

	// Both using include → merge include lists
	if (effFeedMode === 'include' && (effAccountMode === 'include' || effAccountMode === 'none')) {
		const keys: string[] = feedIds.map(rssSourceKey);
		if (effAccountMode === 'include') {
			for (const did of accountDids) {
				if (showShares) keys.push(sharesSourceKey(did));
				if (showDocuments) keys.push(documentsSourceKey(did));
			}
		}
		return { sourceMode: 'include', sourceKeys: keys };
	}

	if ((effFeedMode === 'include' || effFeedMode === 'none') && effAccountMode === 'include') {
		const keys: string[] = [];
		if (effFeedMode === 'include') {
			keys.push(...feedIds.map(rssSourceKey));
		}
		for (const did of accountDids) {
			if (showShares) keys.push(sharesSourceKey(did));
			if (showDocuments) keys.push(documentsSourceKey(did));
		}
		return { sourceMode: 'include', sourceKeys: keys };
	}

	// Both using exclude → merge exclude lists
	if (effFeedMode === 'exclude' && (effAccountMode === 'exclude' || effAccountMode === 'none')) {
		const keys: string[] = feedIds.map(rssSourceKey);
		if (effAccountMode === 'exclude') {
			for (const did of accountDids) {
				if (showShares) keys.push(sharesSourceKey(did));
				if (showDocuments) keys.push(documentsSourceKey(did));
			}
		}
		// Also exclude all account sources if account mode is none
		if (effAccountMode === 'none') {
			for (const did of allDids) {
				keys.push(sharesSourceKey(did));
				keys.push(documentsSourceKey(did));
			}
		}
		return { sourceMode: 'exclude', sourceKeys: keys };
	}

	if ((effFeedMode === 'exclude' || effFeedMode === 'none') && effAccountMode === 'exclude') {
		const keys: string[] = [];
		if (effFeedMode === 'exclude') {
			keys.push(...feedIds.map(rssSourceKey));
		}
		for (const did of accountDids) {
			if (showShares) keys.push(sharesSourceKey(did));
			if (showDocuments) keys.push(documentsSourceKey(did));
		}
		// Also exclude all RSS if feed mode is none
		if (effFeedMode === 'none') {
			for (const id of allSubIds) {
				keys.push(rssSourceKey(id));
			}
		}
		return { sourceMode: 'exclude', sourceKeys: keys };
	}

	// Mixed include/exclude — convert to include (enumerate the "all" dimension)
	// Feed=all + Account=include → include all RSS + specified account sources
	if (effFeedMode === 'all' && effAccountMode === 'include') {
		const keys: string[] = allSubIds.map(rssSourceKey);
		for (const did of accountDids) {
			if (showShares) keys.push(sharesSourceKey(did));
			if (showDocuments) keys.push(documentsSourceKey(did));
		}
		return { sourceMode: 'include', sourceKeys: keys };
	}

	// Feed=all + Account=exclude → exclude specified account sources (+ disabled types)
	if (effFeedMode === 'all' && effAccountMode === 'exclude') {
		const keys: string[] = [];
		for (const did of accountDids) {
			keys.push(sharesSourceKey(did));
			keys.push(documentsSourceKey(did));
		}
		// Also exclude disabled content types for non-excluded DIDs
		if (!showShares || !showDocuments) {
			for (const did of allDids) {
				if (accountDids.includes(did)) continue; // already fully excluded
				if (!showShares) keys.push(sharesSourceKey(did));
				if (!showDocuments) keys.push(documentsSourceKey(did));
			}
		}
		return { sourceMode: 'exclude', sourceKeys: keys };
	}

	// Feed=include + Account=all → include specified feeds + all account sources
	if (effFeedMode === 'include' && effAccountMode === 'all') {
		const keys: string[] = feedIds.map(rssSourceKey);
		for (const did of allDids) {
			if (showShares) keys.push(sharesSourceKey(did));
			if (showDocuments) keys.push(documentsSourceKey(did));
		}
		return { sourceMode: 'include', sourceKeys: keys };
	}

	// Feed=exclude + Account=all → exclude specified feeds (+ disabled account types)
	if (effFeedMode === 'exclude' && effAccountMode === 'all') {
		const keys: string[] = feedIds.map(rssSourceKey);
		if (!showShares || !showDocuments) {
			for (const did of allDids) {
				if (!showShares) keys.push(sharesSourceKey(did));
				if (!showDocuments) keys.push(documentsSourceKey(did));
			}
		}
		return { sourceMode: 'exclude', sourceKeys: keys };
	}

	// Feed=all + Account=none → exclude all account sources
	if (effFeedMode === 'all' && effAccountMode === 'none') {
		const keys: string[] = [];
		for (const did of allDids) {
			keys.push(sharesSourceKey(did));
			keys.push(documentsSourceKey(did));
		}
		return { sourceMode: 'exclude', sourceKeys: keys };
	}

	// Feed=none + Account=all → exclude all RSS
	if (effFeedMode === 'none' && effAccountMode === 'all') {
		const keys: string[] = allSubIds.map(rssSourceKey);
		if (!showShares || !showDocuments) {
			for (const did of allDids) {
				if (!showShares) keys.push(sharesSourceKey(did));
				if (!showDocuments) keys.push(documentsSourceKey(did));
			}
		}
		return { sourceMode: 'exclude', sourceKeys: keys };
	}

	// Feed=none + Account=include → include only specified account sources
	if (effFeedMode === 'none' && effAccountMode === 'include') {
		const keys: string[] = [];
		for (const did of accountDids) {
			if (showShares) keys.push(sharesSourceKey(did));
			if (showDocuments) keys.push(documentsSourceKey(did));
		}
		return { sourceMode: 'include', sourceKeys: keys };
	}

	// Feed=none + Account=exclude → include all account sources except excluded
	if (effFeedMode === 'none' && effAccountMode === 'exclude') {
		const excludedSet = new Set(accountDids);
		const keys: string[] = [];
		for (const did of allDids) {
			if (excludedSet.has(did)) continue;
			if (showShares) keys.push(sharesSourceKey(did));
			if (showDocuments) keys.push(documentsSourceKey(did));
		}
		return { sourceMode: 'include', sourceKeys: keys };
	}

	// Feed=include + Account=exclude → include feeds + all account sources minus excluded
	if (effFeedMode === 'include' && effAccountMode === 'exclude') {
		const excludedSet = new Set(accountDids);
		const keys: string[] = feedIds.map(rssSourceKey);
		for (const did of allDids) {
			if (excludedSet.has(did)) continue;
			if (showShares) keys.push(sharesSourceKey(did));
			if (showDocuments) keys.push(documentsSourceKey(did));
		}
		return { sourceMode: 'include', sourceKeys: keys };
	}

	// Feed=exclude + Account=include → all feeds minus excluded + specified account sources
	if (effFeedMode === 'exclude' && effAccountMode === 'include') {
		const excludedFeedSet = new Set(feedIds);
		const keys: string[] = [];
		for (const id of allSubIds) {
			if (!excludedFeedSet.has(id)) keys.push(rssSourceKey(id));
		}
		for (const did of accountDids) {
			if (showShares) keys.push(sharesSourceKey(did));
			if (showDocuments) keys.push(documentsSourceKey(did));
		}
		return { sourceMode: 'include', sourceKeys: keys };
	}

	// Fallback: all
	return { sourceMode: 'all', sourceKeys: [] };
}
