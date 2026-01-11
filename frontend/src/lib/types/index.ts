export interface User {
  did: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  pdsUrl: string;
}

export interface Subscription {
  id?: number;
  atUri: string;
  rkey: string;
  feedUrl: string;
  title: string;
  siteUrl?: string;
  category?: string;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  syncStatus: 'synced' | 'pending' | 'conflict';
  localUpdatedAt: number;
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
  atUri?: string;
  rkey?: string;
  subscriptionAtUri: string;
  articleGuid: string;
  articleUrl: string;
  articleTitle?: string;
  readAt: string;
  scrollPosition?: number;
  starred: boolean;
  syncStatus: 'synced' | 'pending';
}

export interface SocialShare {
  id?: number;
  authorDid: string;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
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
}

export interface UserShare {
  id?: number;
  atUri?: string;
  rkey?: string;
  subscriptionAtUri?: string;
  feedUrl?: string;
  articleGuid: string;
  articleUrl: string;
  articleTitle?: string;
  articleAuthor?: string;
  articleDescription?: string;
  articleImage?: string;
  articlePublishedAt?: string;
  note?: string;
  createdAt: string;
  syncStatus: 'synced' | 'pending';
}

export interface SyncQueueItem {
  id?: number;
  operation: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  record?: Record<string, unknown>;
  timestamp: number;
  retryCount: number;
  lastError?: string;
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
