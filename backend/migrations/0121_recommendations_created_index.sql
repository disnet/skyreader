-- The public link pages' front (GET /api/public/recommends) reads every
-- reader's recent recommends at once, so it needs an index on time alone.
CREATE INDEX IF NOT EXISTS idx_recommendations_created
    ON recommendations (created_at DESC);
