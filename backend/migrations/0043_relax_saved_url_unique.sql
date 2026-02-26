-- Drop UNIQUE(user_did, url) constraint to allow share/document saves with duplicate URLs.
-- SQLite requires recreating the table to drop a constraint.

-- 1. Create new table without the url unique constraint
CREATE TABLE saved_articles_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_did TEXT NOT NULL,
    rkey TEXT NOT NULL,
    record_uri TEXT,
    url TEXT NOT NULL DEFAULT '',
    title TEXT,
    author TEXT,
    description TEXT,
    content TEXT,
    content_type TEXT DEFAULT 'webpage',
    domain TEXT,
    image TEXT,
    word_count INTEGER,
    published_at INTEGER,
    saved_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    source TEXT NOT NULL DEFAULT 'url',
    item_guid TEXT,
    UNIQUE(user_did, rkey)
);

-- 2. Copy data
INSERT INTO saved_articles_new (id, user_did, rkey, record_uri, url, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source, item_guid)
SELECT id, user_did, rkey, record_uri, url, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source, item_guid
FROM saved_articles;

-- 3. Drop old table
DROP TABLE saved_articles;

-- 4. Rename new table
ALTER TABLE saved_articles_new RENAME TO saved_articles;

-- 5. Recreate indexes
CREATE INDEX idx_saved_articles_user ON saved_articles(user_did);
CREATE INDEX idx_saved_articles_guid ON saved_articles(user_did, item_guid);
