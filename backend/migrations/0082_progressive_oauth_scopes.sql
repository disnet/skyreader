-- Progressive OAuth scope requests (see docs/OAUTH_SCOPES.md).
--
-- users.oauth_features: the optional features (space-separated ScopeFeature
-- names, e.g. "semble linkblog") whose permissions the reader last granted, so
-- the next sign-in asks for the same set again. NULL = never recorded; sign-in
-- then falls back to whatever the reader's live sessions were granted.
ALTER TABLE users ADD COLUMN oauth_features TEXT;

-- oauth_state.scope: the exact scope string this authorization requested, so the
-- callback can record it when a token response omits `scope`.
-- oauth_state.replace_session_id: set by POST /api/auth/upgrade; the callback
-- retires that session once the upgraded one for the same account is stored.
ALTER TABLE oauth_state ADD COLUMN scope TEXT;
ALTER TABLE oauth_state ADD COLUMN replace_session_id TEXT;
