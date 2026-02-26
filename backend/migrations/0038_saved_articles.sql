-- Saved articles extracted from URLs
CREATE TABLE IF NOT EXISTS saved_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    record_uri TEXT,
    url TEXT NOT NULL,
    title TEXT,
    author TEXT,
    description TEXT,
    content TEXT,
    domain TEXT,
    image TEXT,
    word_count INTEGER,
    published_at INTEGER,
    saved_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    UNIQUE(user_did, url),
    UNIQUE(user_did, rkey)
);
CREATE INDEX idx_saved_articles_user ON saved_articles(user_did);
