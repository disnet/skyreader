-- From your follows: whether the reader wants every link their follows shared,
-- newest first, instead of the week's most-shared (the default, capped at 60).
-- NULL or 0 = most-shared; 1 = all. On the sync row with in_everything, the one
-- per-reader follows row. See docs/plans/FOLLOWS_LINKS_PLAN.md.
ALTER TABLE follow_link_sync ADD COLUMN all_links INTEGER;
