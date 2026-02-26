-- OAuth state table as fallback when KV limit is reached
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  did TEXT NOT NULL,
  handle TEXT NOT NULL,
  pds_url TEXT NOT NULL,
  auth_server TEXT NOT NULL,
  return_url TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_oauth_state_expires ON oauth_state(expires_at);
