-- Email newsletters (a Supporter feature). Each reader gets one private inbox
-- address; mail sent to it lands in their reader as a subscription per sender.
-- See docs/plans/EMAIL_NEWSLETTERS.md.
--
-- inbox_id names the reader's newsletter feeds (feed_url `newsletter:<inbox_id>/<sender>`)
-- and never changes. address_token is the secret local part of the address; rotating
-- it kills the old address without orphaning the feeds already received.
-- day_bucket/day_count bound how much one inbox can write per UTC day, so a leaked
-- address can't flood the archive.
CREATE TABLE IF NOT EXISTS newsletter_inboxes (
  user_did TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL UNIQUE,
  address_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  rotated_at INTEGER,
  last_received_at INTEGER,
  day_bucket INTEGER NOT NULL DEFAULT 0,
  day_count INTEGER NOT NULL DEFAULT 0
);

-- Senders the reader unsubscribed from in Skyreader. Deleting a newsletter
-- subscription can't unsubscribe at the source, so without this the next issue
-- would quietly re-create it. Mail from a blocked sender is accepted and dropped.
CREATE TABLE IF NOT EXISTS newsletter_blocked_senders (
  user_did TEXT NOT NULL,
  sender TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_did, sender)
);
