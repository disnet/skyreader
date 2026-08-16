-- No companion index. The only reader is getDisabledLinkblogAuthors, whose
-- `WHERE linkblog_disabled = 1 AND user_did IN (...)` is served by the user_did
-- PRIMARY KEY; a partial index keyed on user_did would never be chosen. (Compare
-- 0064, which leads with linkblog_publication — a non-key column — and does earn
-- its keep.) Nothing asks for "every disabled user", so there is no scan to fix.
ALTER TABLE user_settings ADD COLUMN linkblog_disabled INTEGER NOT NULL DEFAULT 0;
