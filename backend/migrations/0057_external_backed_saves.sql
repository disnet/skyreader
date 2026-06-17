-- External-backed saves: back the Saved list with a Semble/Margin collection.
--
-- See docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md. The read path is TWO STORES, not
-- one (this is the safety property): an ENRICHMENT store (saved_articles) holding
-- reading work, which a poll NEVER deletes from, and a MEMBERSHIP SNAPSHOT
-- (backed_collection_members) replaced WHOLESALE from each provably-complete poll.
-- The Saved set is membership ⋈ enrichment, joined on url_normalized. A botched
-- poll can only stale the displayed membership (recovered next good poll); it can
-- never strip a body or a highlight.
--
-- Provider-agnostic by design: external_* are foreign at-uri HANDLES, so they hold
-- a Semble card + collectionLink, OR a Margin community.lexicon.bookmarks.bookmark
-- + collectionItem (which Phase 0 proved can live in a DIFFERENT repo than the
-- collection owner — a plain TEXT at-uri stores either).

-- (1) Enrichment store gains the cross-app JOIN KEY. normalizeArticleUrl(url) lives
--     in feed-proxy today; Phase 1 ports a backend copy for the backfill + write
--     paths. Existing rows stay NULL until backfilled; SQLite treats NULLs as
--     distinct in a UNIQUE index, so the index does not collide on un-backfilled rows.
ALTER TABLE saved_articles ADD COLUMN url_normalized TEXT;
CREATE UNIQUE INDEX idx_saved_articles_dedup ON saved_articles(user_did, url_normalized);

-- (2) Membership snapshot: the latest PROVABLY-COMPLETE listRecords snapshot of a
--     backed collection, replaced WHOLESALE per good poll (DELETE the collection's
--     rows, bulk-INSERT the snapshot — one atomic D1 batch; never row-diffed).
--     The external_* fields are foreign HANDLES (what to read/delete), not identity.
--     Reading work never lives here.
CREATE TABLE backed_collection_members (
  user_did            TEXT NOT NULL,
  external_collection TEXT NOT NULL,  -- backing collection at-uri
  url_normalized      TEXT NOT NULL,  -- join key into saved_articles
  url                 TEXT NOT NULL,  -- resolved web URL (raw)
  external_provider   TEXT NOT NULL,  -- 'semble' | 'margin'
  external_item_uri   TEXT NOT NULL,  -- card / bookmark / note at-uri (may be cross-repo)
  external_link_uri   TEXT NOT NULL,  -- collectionLink / collectionItem (deleted on unsave)
  metadata            TEXT,           -- JSON: title/author/etc + canonical at:// (Semble only)
  PRIMARY KEY (user_did, external_collection, url_normalized)
);
CREATE INDEX idx_backed_members_collection ON backed_collection_members(user_did, external_collection);

-- (3) Short-lived unsave tombstones: suppress a just-unsaved URL until a snapshot
--     confirms the foreign membership is actually gone, so a fire-and-forget
--     membership delete that hasn't propagated can't be resurrected by the next
--     wholesale-replace poll. Cleared when a complete poll no longer lists the URL;
--     a TTL backstop surfaces a permanently-stuck delete. See Phase 4.
CREATE TABLE backed_unsave_tombstones (
  user_did            TEXT NOT NULL,
  external_collection TEXT NOT NULL,
  url_normalized      TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (user_did, external_collection, url_normalized)
);

-- (4) Backing configuration, one per user. 'skyreader' (or NULL) = today's behavior
--     (app.skyreader.feed.saved export). Otherwise 'semble:<collectionUri>' /
--     'margin:<collectionUri>'. One backing per ACCOUNT, applied to all saves.
ALTER TABLE user_settings ADD COLUMN backing TEXT;

-- (5) Last time we polled+replaced the membership snapshot for this user's backing.
--     One backing per account => one timestamp. Lets the Saved-list-open poll
--     minute-gate itself instead of hitting the PDS on every GET (epoch ms).
ALTER TABLE user_settings ADD COLUMN last_backing_poll INTEGER;
