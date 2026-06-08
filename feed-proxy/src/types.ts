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

// A durable, retained feed item in the `feed_items` log. `seq` is a global
// monotonic cursor (SQLite AUTOINCREMENT rowid, never reused); the client drains
// everything with `seq > sinceSeq` since its last visit. One row per
// (url_hash, guid); a re-published item updates `item_json`/`content_hash` in
// place, keeping its seq (no re-delivery).
export interface FeedItemRow {
  seq: number;
  url_hash: string;
  guid: string;
  item_json: string;
  published_at: number | null;
  first_seen_at: number;
  content_hash: string | null;
}
