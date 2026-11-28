-- Watch for updates: news about saves a reader asked to hear about
-- (services/save-watches.ts, docs/plans/SAVE_WATCHES.md).
--
-- One row per watched save. `seen_at` is when the reader last cleared its
-- updates; news is what arrived after that, or after `created_at` before any
-- clear. Rows of deleted saves are swept hourly (pruneSaveWatches), so read
-- them joined to saved_articles.
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
-- The minute cron's due-target scans.
CREATE INDEX idx_watch_targets_mentions_due ON watch_targets (mentions_checked_at);
CREATE INDEX idx_watch_targets_citations_due ON watch_targets (citations_checked_at)
  WHERE doi IS NOT NULL;

-- What a check found: `count` more people in a mention lane, or `count` new
-- citations, with a few of them described in `detail` (JSON). Pruned at 90 days.
-- `baseline_at` is when the counts it grew from were taken: a reader sees an
-- event only if that was after they started watching, so a URL someone else
-- already watched doesn't hand a new watcher news from before they joined.
CREATE TABLE watch_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url_key     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  lane        TEXT,
  count       INTEGER NOT NULL,
  detail      TEXT,
  baseline_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_watch_events_url_key ON watch_events (url_key, created_at);
