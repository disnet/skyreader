-- Add cli_port column for CLI OAuth flow
ALTER TABLE oauth_state ADD COLUMN cli_port INTEGER;
