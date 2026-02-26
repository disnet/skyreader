-- Clear all sessions to force re-authentication after confidential client migration
-- This is necessary because:
-- 1. Old sessions were created with public client authentication (token_endpoint_auth_method: 'none')
-- 2. New sessions require confidential client authentication (private_key_jwt)
-- 3. The authorization server will reject refresh attempts from old sessions

DELETE FROM sessions;
DELETE FROM oauth_state;
