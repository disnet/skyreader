-- The notification bell's read-state, per account rather than per browser, so a
-- mention read on one device doesn't light the badge on the next.
--
-- `notification_id` is the client's id for a notification: a mention's source
-- at:// URI, a Dev Log post's record URI, or a feedback event id. The server
-- never interprets it. Bounded per reader by routes/notifications.ts.
CREATE TABLE notification_seen (
  user_did        TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  seen_at         INTEGER NOT NULL,
  PRIMARY KEY (user_did, notification_id)
);
CREATE INDEX idx_notification_seen_user_seen_at ON notification_seen(user_did, seen_at);

-- When the account's first sync ran: mentions older than a week start read once,
-- for the account, instead of once per browser (stores/notifications.svelte.ts).
CREATE TABLE notification_state (
  user_did  TEXT PRIMARY KEY,
  primed_at INTEGER NOT NULL
);
