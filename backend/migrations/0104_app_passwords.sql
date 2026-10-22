-- App passwords: credentials for third-party RSS clients (NetNewsWire, Reeder,
-- ReadKit, Unread) that sync through the Google Reader API (routes/greader.ts).
-- Those clients can't do atproto OAuth, so a reader creates one password per app
-- in Settings and revokes it there.
--
-- Only the SHA-256 of the password is stored. Passwords are 100 random bits,
-- so a fast hash is enough: there is nothing to brute-force from the digest.
CREATE TABLE app_passwords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_did     TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER
);
CREATE INDEX idx_app_passwords_user ON app_passwords(user_did);
