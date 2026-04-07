CREATE TABLE IF NOT EXISTS channels (
    uuid TEXT NOT NULL,
    user_did TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (user_did, uuid)
);
CREATE INDEX IF NOT EXISTS idx_channels_user_position ON channels(user_did, position);
