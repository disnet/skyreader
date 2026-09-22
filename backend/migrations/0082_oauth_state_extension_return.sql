-- Browser-extension login: where the OAuth callback hands the new session id
-- (an extension page such as safari-web-extension://<id>/connected.html) when
-- the extension can't ride the web app's session cookie. Mirrors cli_port.
ALTER TABLE oauth_state ADD COLUMN extension_return_url TEXT;
