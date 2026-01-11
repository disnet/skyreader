-- Sessions table as fallback when KV limit is reached
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  pds_url TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  dpop_private_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (did) REFERENCES users(did) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_did ON sessions(did);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
