-- site.standard.document records from followed users
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_did TEXT NOT NULL,
    record_uri TEXT UNIQUE NOT NULL,
    record_cid TEXT NOT NULL,
    site_uri TEXT NOT NULL,
    title TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    path TEXT,
    description TEXT,
    cover_image_cid TEXT,
    text_content TEXT,
    bsky_post_uri TEXT,
    tags TEXT,
    updated_at INTEGER,
    canonical_url TEXT,
    indexed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_author ON documents(author_did);
CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_canonical_url ON documents(canonical_url);
