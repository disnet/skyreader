-- A third app-password scope (services/app-passwords.ts):
--   'push' - post to the reader's push feeds (routes/push.ts) and nothing else:
--            it reads nothing, so a script or agent holding it can't see the library
-- SQLite can't alter a CHECK, so the table is rebuilt with the same rows and ids.
CREATE TABLE app_passwords_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_did     TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  scope        TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'highlights', 'push'))
);
INSERT INTO app_passwords_new (id, user_did, name, token_hash, created_at, last_used_at, scope)
  SELECT id, user_did, name, token_hash, created_at, last_used_at, scope FROM app_passwords;
DROP TABLE app_passwords;
ALTER TABLE app_passwords_new RENAME TO app_passwords;
CREATE INDEX idx_app_passwords_user ON app_passwords(user_did);
