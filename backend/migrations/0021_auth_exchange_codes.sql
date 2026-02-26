-- Store short-lived exchange codes for secure session handoff
-- These replace passing sessionId directly in URLs
CREATE TABLE IF NOT EXISTS auth_exchange_codes (
  code TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Index for cleanup of expired codes
CREATE INDEX IF NOT EXISTS idx_auth_exchange_codes_expires ON auth_exchange_codes(expires_at);
