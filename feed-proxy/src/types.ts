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

export interface ParsedFeed {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  fetchedAt: number;
}

export interface FeedRow {
  url: string;
  title: string | null;
  site_url: string | null;
  description: string | null;
  image_url: string | null;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: number;
  error_count: number;
  last_error: string | null;
}

export interface ItemRow {
  id: string;
  feed_url: string;
  guid: string;
  url: string;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  image_url: string | null;
  published_at: number;
  fetched_at: number;
}
