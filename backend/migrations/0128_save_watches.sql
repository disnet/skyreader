-- Watch for updates: news about saves a reader asked to hear about
-- (services/save-watches.ts, docs/plans/SAVE_WATCHES.md).
--
-- One row per watched save. `seen_at` is when the reader last cleared its
-- updates; news is what arrived after that, or after `created_at` before any
-- clear. A deleted save takes its row with it (routes/saved.ts).
CREATE TABLE save_watches (
  user_did   TEXT NOT NULL,
  rkey       TEXT NOT NULL,
  url_key    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at    INTEGER,
  PRIMARY KEY (user_did, rkey)
);
CREATE INDEX idx_save_watches_url_key ON save_watches (url_key);

-- What is checked, once per normalized URL however many readers watch it.
-- `mention_counts` (JSON, lane -> distinct people) and `citations` are the
-- baselines the next check compares with; NULL until the first settled check,
-- so turning Watch on never reports what was already there.
CREATE TABLE watch_targets (
  url_key              TEXT PRIMARY KEY,
  url                  TEXT NOT NULL,
  doi                  TEXT,
  mention_counts       TEXT,
  mentions_checked_at  INTEGER,
  mentions_queued_at   INTEGER,
  citations            INTEGER,
  openalex_id          TEXT,
  citations_checked_at INTEGER,
  citations_queued_at  INTEGER
);

-- What a check found: `count` more people in a mention lane, or `count` new
-- citations, with a few of them described in `detail` (JSON). Pruned at 90 days.
CREATE TABLE watch_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url_key    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  lane       TEXT,
  count      INTEGER NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_watch_events_url_key ON watch_events (url_key, created_at);
