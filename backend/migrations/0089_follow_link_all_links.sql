-- From your follows: whether the river shows every link the reader's follows
-- shared, newest first and paged (GET /following-links/all), instead of the
-- week's most-shared (the default, capped at 60; Home shows that either way).
-- NULL or 0 = most-shared; 1 = all. On the sync row with in_everything, the one
-- per-reader follows row. See docs/plans/FOLLOWS_LINKS_PLAN.md.
ALTER TABLE follow_link_sync ADD COLUMN all_links INTEGER;
