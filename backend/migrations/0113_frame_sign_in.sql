-- Sign-in from inside a workspace frame (atworkplace). A framed Skyreader can't
-- receive the OAuth callback's cookie: the popup that runs sign-in is top-level,
-- so the cookie lands in the unpartitioned jar the frame never sees. Instead the
-- frame picks a random relay secret and sends only its SHA-256 with the login
-- request. The callback parks the new session under that hash, and the frame
-- claims it with the secret, getting its own partitioned cookie
-- (routes/frame-sign-in.ts).
ALTER TABLE oauth_state ADD COLUMN frame_relay_hash TEXT;
-- The SHA-256 of a cookie set in the browser that started the sign-in. The
-- callback only parks the session if the browser finishing it carries that
-- cookie, so a sign-in link someone else started can't hand them your session.
ALTER TABLE oauth_state ADD COLUMN frame_binding_hash TEXT;

-- One row per finished framed sign-in, waiting to be claimed. Single use (the
-- claim deletes it) and short-lived (expires_at, cleaned up hourly).
CREATE TABLE frame_sign_in (
  relay_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
