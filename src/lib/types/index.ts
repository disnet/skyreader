export interface User {
	did: string;
	handle: string;
	displayName?: string;
	avatarUrl?: string;
	pdsUrl: string;
}

export interface Subscription {
	id?: number;
	rkey: string;
	feedUrl: string;
	title: string;
	siteUrl?: string;
	category?: string;
	tags: string[];
	createdAt: string;
	updatedAt?: string;
	localUpdatedAt: number;
	fetchStatus?: 'pending' | 'ready' | 'error';
	lastFetchedAt?: number;
	fetchError?: string;
	source?: 'manual' | 'opml';
	customTitle?: string; // User-set title override (local only)
	customIconUrl?: string; // User-set icon override (local only)
}

export interface Article {
	id?: number;
	subscriptionId: number;
	guid: string;
	url: string;
	title: string;
	author?: string;
	content?: string;
	summary?: string;
	imageUrl?: string;
	publishedAt: string;
	fetchedAt: number;
}

export interface ReadPosition {
	id?: number;
	rkey?: string;
	subscriptionRkey: string;
	articleGuid: string;
	articleUrl: string;
	articleTitle?: string;
	readAt: string;
	scrollPosition?: number;
	starred: boolean;
}

export interface ShareReadPosition {
	id?: number;
	rkey?: string;
	shareUri: string;
	shareAuthorDid: string;
	itemUrl: string;
	itemTitle?: string;
	readAt: string;
}

export interface SocialShare {
	id?: number;
	authorDid: string;
	recordUri: string;
	feedUrl?: string;
	itemUrl: string;
	itemTitle?: string;
	itemAuthor?: string;
	itemDescription?: string;
	itemImage?: string;
	itemGuid?: string;
	itemPublishedAt?: string;
	note?: string;
	content?: string;
	createdAt: string;
	reshareOf?: {
		uri: string;
		authorDid: string;
	};
	reshareCount?: number;
}

// Grouped share for deduplicated feed
export interface GroupedShare {
	itemUrl: string;
	itemTitle?: string;
	itemAuthor?: string;
	itemDescription?: string;
	itemImage?: string;
	itemGuid?: string;
	itemPublishedAt?: string;
	feedUrl?: string;
	content?: string;
	sharers: Array<{
		did: string;
		recordUri: string;
		createdAt: string;
		note?: string;
		reshareCount: number;
	}>;
	firstSharer: {
		did: string;
		recordUri: string;
	};
	totalShareCount: number;
	latestShareAt: string;
}

// Reshare activity item (grouped by article)
export interface ReshareActivity {
	originalShare: {
		uri: string;
		itemUrl: string;
		itemTitle?: string;
	};
	resharers: Array<{
		did: string;
		resharedAt: string;
	}>;
	totalCount: number;
	latestReshareAt: string;
}

// Profile info fetched from Bluesky
export interface BlueskyProfile {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
}

export interface UserShare {
	id?: number;
	rkey?: string;
	subscriptionRkey?: string;
	feedUrl?: string;
	articleGuid: string;
	articleUrl: string;
	articleTitle?: string;
	articleAuthor?: string;
	articleDescription?: string;
	articleContent?: string;
	articleImage?: string;
	articlePublishedAt?: string;
	note?: string;
	createdAt: string;
	reshareOf?: {
		uri: string;
		authorDid: string;
	};
	reshareCount?: number;
}

export interface ParsedFeed {
	title: string;
	description?: string;
	siteUrl?: string;
	imageUrl?: string;
	items: FeedItem[];
	fetchedAt: number;
}

export interface FeedItem {
	guid: string;
	url: string;
	title: string;
	author?: string;
	content?: string;
	summary?: string;
	imageUrl?: string;
	publishedAt: string;
}

// Combined feed item for unified "all" view
export type CombinedFeedItem =
	| { type: 'article'; item: Article; date: string }
	| { type: 'share'; item: SocialShare; date: string };

export interface DiscoverUser {
	did: string;
	handle: string;
	displayName?: string;
	avatarUrl?: string;
	shareCount: number;
}

export interface InappFollow {
	id?: number;
	rkey?: string;
	subjectDid: string;
	createdAt: string;
}
