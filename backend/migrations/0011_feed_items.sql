-- Store individual feed items for efficient querying
CREATE TABLE IF NOT EXISTS feed_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_url TEXT NOT NULL,
    guid TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    summary TEXT,
    content TEXT,
    image_url TEXT,
    published_at INTEGER NOT NULL,  -- Unix timestamp for efficient queries
    fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
    content_hash TEXT,              -- For change detection
    UNIQUE(feed_url, guid)
);

-- Index for fetching items by feed
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_url ON feed_items(feed_url);

-- Index for cross-feed queries sorted by date
CREATE INDEX IF NOT EXISTS idx_feed_items_published_at ON feed_items(published_at DESC);

-- Composite index for feed-specific date queries
CREATE INDEX IF NOT EXISTS idx_feed_items_feed_published ON feed_items(feed_url, published_at DESC);

-- Index for looking up items by URL (for social features)
CREATE INDEX IF NOT EXISTS idx_feed_items_url ON feed_items(url);
