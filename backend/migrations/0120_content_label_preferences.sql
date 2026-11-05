-- The reader's Show / Warn / Hide choice per content label (a writer's self-label
-- on a standard.site document, such as `ai-generated`), so it follows the account
-- across devices. JSON object of label -> 'show' | 'warn' | 'hide'; only labels the
-- reader changed are stored. NULL = every label at its default.
ALTER TABLE user_settings ADD COLUMN content_labels TEXT;
