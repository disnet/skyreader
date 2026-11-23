-- Semble cards a background copy wrote but couldn't link into the backing
-- collection (services/backing/enable.ts exportNativeSaves). A Semble copy writes
-- the card, then the link; when the PDS refuses the link for its rate limit, it
-- refuses the card's cleanup delete too. The next attempt at the same save links
-- this card instead of writing a second one. Deleted once linked.
CREATE TABLE IF NOT EXISTS backing_stray_cards (
  user_did TEXT NOT NULL,
  url_normalized TEXT NOT NULL,
  card_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_did, url_normalized)
);
