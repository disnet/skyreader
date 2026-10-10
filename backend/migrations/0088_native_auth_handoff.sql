-- Native (macOS/iOS) sign-in. The app starts login with a PKCE-style challenge
-- (SHA-256 of a secret it keeps); the callback hands back a one-time code on the
-- skyreader:// scheme instead of the session, and the app trades code + secret
-- for the session at POST /api/auth/native/exchange. See routes/native-auth.ts.
ALTER TABLE oauth_state ADD COLUMN native_challenge TEXT;

CREATE TABLE native_auth_handoff (
  code TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
