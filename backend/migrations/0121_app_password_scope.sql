-- What an app password may be used for (services/app-passwords.ts):
--   'full'       - the Google Reader API and highlight sync (every password made before this)
--   'highlights' - highlight sync only (routes/highlight-sync.ts): the Obsidian
--                  plugin's, which never needs to touch subscriptions or read state
ALTER TABLE app_passwords ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';
