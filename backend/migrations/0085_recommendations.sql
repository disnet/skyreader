-- Recommends: the reader's own one-tap public recommendations. The record of
-- truth is app.skyreader.social.recommend in their repo (plus, for a
-- standard.site document, a site.standard.graph.recommend beside it); this row
-- is the index that answers "have I recommended this?" without listing the repo,
-- and holds the rkeys an un-recommend deletes. One per (reader, article).
CREATE TABLE IF NOT EXISTS recommendations (
    did            TEXT NOT NULL,
    url_normalized TEXT NOT NULL,  -- normalizeArticleUrl(url), same key as saved_articles
    url            TEXT NOT NULL,  -- the URL as recommended (what the record's subject says)
    title          TEXT,
    rkey           TEXT NOT NULL,  -- app.skyreader.social.recommend record
    document_uri   TEXT,           -- the site.standard.document, when the article is one
    standard_rkey  TEXT,           -- its site.standard.graph.recommend, when written
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (did, url_normalized)
);

CREATE INDEX IF NOT EXISTS idx_recommendations_did_created
    ON recommendations (did, created_at DESC);
