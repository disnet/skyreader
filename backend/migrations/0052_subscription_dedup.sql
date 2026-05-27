-- Eliminate duplicate RSS subscriptions and prevent future duplicates.
--
-- A user may end up with two subscriptions_cache rows pointing at the same
-- logical feed when:
--   1. The same URL is added with different casing / trailing slash.
--   2. Two parallel POSTs race past the frontend in-memory dedup check.
--
-- This migration cleans up existing duplicates and installs partial UNIQUE
-- indexes that make a duplicate write fail loudly going forward.
--
-- The normalization performed here mirrors backend/src/lib/feed-url.ts:
--   - lowercase host
--   - strip default ports (:80 on http, :443 on https)
--   - drop URL fragment
--   - strip a single trailing slash on a non-root path
--   - preserve the query string verbatim
--   - never rewrite the scheme

-- Step 1: build a normalized form of each RSS feed URL.
-- Limitation: SQLite lacks a URL parser, so we approximate using string ops
-- targeted at the variants seen in practice. The TS normalizer is still the
-- authoritative form — this CTE just needs to cluster duplicates correctly.
WITH normalized AS (
    SELECT
        id,
        user_did,
        feed_url,
        (
            -- Drop fragment
            CASE WHEN INSTR(feed_url, '#') > 0
                 THEN SUBSTR(feed_url, 1, INSTR(feed_url, '#') - 1)
                 ELSE feed_url
            END
        ) AS no_fragment
    FROM subscriptions_cache
    WHERE source_type IS NULL OR source_type = 'rss'
),
parsed AS (
    SELECT
        id,
        user_did,
        feed_url,
        -- Split scheme from rest
        CASE
            WHEN INSTR(no_fragment, '://') > 0
            THEN LOWER(SUBSTR(no_fragment, 1, INSTR(no_fragment, '://') - 1))
            ELSE ''
        END AS scheme,
        CASE
            WHEN INSTR(no_fragment, '://') > 0
            THEN SUBSTR(no_fragment, INSTR(no_fragment, '://') + 3)
            ELSE no_fragment
        END AS rest
    FROM normalized
),
split_path AS (
    SELECT
        id,
        user_did,
        feed_url,
        scheme,
        CASE
            WHEN INSTR(rest, '/') > 0
            THEN LOWER(SUBSTR(rest, 1, INSTR(rest, '/') - 1))
            ELSE LOWER(rest)
        END AS authority,
        CASE
            WHEN INSTR(rest, '/') > 0
            THEN SUBSTR(rest, INSTR(rest, '/'))
            ELSE '/'
        END AS path_and_query
    FROM parsed
),
host_port AS (
    SELECT
        id,
        user_did,
        feed_url,
        scheme,
        -- Strip default ports
        CASE
            WHEN scheme = 'https' AND authority LIKE '%:443'
                THEN SUBSTR(authority, 1, LENGTH(authority) - 4)
            WHEN scheme = 'http' AND authority LIKE '%:80'
                THEN SUBSTR(authority, 1, LENGTH(authority) - 3)
            ELSE authority
        END AS authority,
        -- Separate path from query so we only trim the trailing slash on the path
        CASE
            WHEN INSTR(path_and_query, '?') > 0
            THEN SUBSTR(path_and_query, 1, INSTR(path_and_query, '?') - 1)
            ELSE path_and_query
        END AS path_only,
        CASE
            WHEN INSTR(path_and_query, '?') > 0
            THEN SUBSTR(path_and_query, INSTR(path_and_query, '?'))
            ELSE ''
        END AS query_only
    FROM split_path
),
final_norm AS (
    SELECT
        id,
        user_did,
        feed_url,
        scheme || '://' || authority
            || CASE
                WHEN LENGTH(path_only) > 1 AND SUBSTR(path_only, LENGTH(path_only), 1) = '/'
                    THEN SUBSTR(path_only, 1, LENGTH(path_only) - 1)
                ELSE path_only
            END
            || query_only AS normalized_url
    FROM host_port
),
ranked AS (
    SELECT
        id,
        user_did,
        feed_url,
        normalized_url,
        -- Keep the oldest (smallest id) row per (user, normalized_url).
        ROW_NUMBER() OVER (
            PARTITION BY user_did, normalized_url
            ORDER BY id
        ) AS rn
    FROM final_norm
)
DELETE FROM subscriptions_cache
WHERE id IN (
    SELECT id FROM ranked WHERE rn > 1
);

-- Step 2: rewrite the kept rows' feed_url to its normalized form, so the
-- unique index below actually enforces dedup against any future writes
-- (which will already normalise via the application layer).
WITH normalized AS (
    SELECT
        id,
        feed_url,
        (
            CASE WHEN INSTR(feed_url, '#') > 0
                 THEN SUBSTR(feed_url, 1, INSTR(feed_url, '#') - 1)
                 ELSE feed_url
            END
        ) AS no_fragment
    FROM subscriptions_cache
    WHERE source_type IS NULL OR source_type = 'rss'
),
parsed AS (
    SELECT
        id,
        feed_url,
        CASE
            WHEN INSTR(no_fragment, '://') > 0
            THEN LOWER(SUBSTR(no_fragment, 1, INSTR(no_fragment, '://') - 1))
            ELSE ''
        END AS scheme,
        CASE
            WHEN INSTR(no_fragment, '://') > 0
            THEN SUBSTR(no_fragment, INSTR(no_fragment, '://') + 3)
            ELSE no_fragment
        END AS rest
    FROM normalized
),
split_path AS (
    SELECT
        id,
        feed_url,
        scheme,
        CASE
            WHEN INSTR(rest, '/') > 0
            THEN LOWER(SUBSTR(rest, 1, INSTR(rest, '/') - 1))
            ELSE LOWER(rest)
        END AS authority,
        CASE
            WHEN INSTR(rest, '/') > 0
            THEN SUBSTR(rest, INSTR(rest, '/'))
            ELSE '/'
        END AS path_and_query
    FROM parsed
),
host_port AS (
    SELECT
        id,
        feed_url,
        scheme,
        CASE
            WHEN scheme = 'https' AND authority LIKE '%:443'
                THEN SUBSTR(authority, 1, LENGTH(authority) - 4)
            WHEN scheme = 'http' AND authority LIKE '%:80'
                THEN SUBSTR(authority, 1, LENGTH(authority) - 3)
            ELSE authority
        END AS authority,
        CASE
            WHEN INSTR(path_and_query, '?') > 0
            THEN SUBSTR(path_and_query, 1, INSTR(path_and_query, '?') - 1)
            ELSE path_and_query
        END AS path_only,
        CASE
            WHEN INSTR(path_and_query, '?') > 0
            THEN SUBSTR(path_and_query, INSTR(path_and_query, '?'))
            ELSE ''
        END AS query_only
    FROM split_path
),
final_norm AS (
    SELECT
        id,
        feed_url,
        scheme || '://' || authority
            || CASE
                WHEN LENGTH(path_only) > 1 AND SUBSTR(path_only, LENGTH(path_only), 1) = '/'
                    THEN SUBSTR(path_only, 1, LENGTH(path_only) - 1)
                ELSE path_only
            END
            || query_only AS normalized_url
    FROM host_port
)
UPDATE subscriptions_cache
SET feed_url = (SELECT normalized_url FROM final_norm WHERE final_norm.id = subscriptions_cache.id)
WHERE id IN (SELECT id FROM final_norm WHERE normalized_url != feed_url);

-- Step 3: dedup AT Proto subscriptions on (user_did, source_type, subject_did).
-- Keep the oldest row per group; the new UNIQUE index below enforces this.
WITH ranked_atproto AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY user_did, source_type, subject_did
            ORDER BY id
        ) AS rn
    FROM subscriptions_cache
    WHERE source_type LIKE 'atproto.%'
      AND subject_did IS NOT NULL
)
DELETE FROM subscriptions_cache
WHERE id IN (
    SELECT id FROM ranked_atproto WHERE rn > 1
);

-- Step 4: partial UNIQUE indexes. These prevent a second row from being
-- inserted for the same logical feed (RSS) or the same followed actor
-- (AT Proto). Using IF NOT EXISTS so partial-apply on prod D1 is safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_cache_user_feed_url
    ON subscriptions_cache(user_did, feed_url)
    WHERE source_type IS NULL OR source_type = 'rss';

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_cache_user_subject
    ON subscriptions_cache(user_did, source_type, subject_did)
    WHERE source_type LIKE 'atproto.%' AND subject_did IS NOT NULL;
