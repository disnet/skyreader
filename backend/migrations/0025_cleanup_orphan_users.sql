-- Delete non-Skyreader users who have no shares
-- These are legacy "followed on Bluesky" users that are no longer tracked
-- Safety: All code paths either JOIN shares, filter pds_url != '', or use LEFT JOIN
DELETE FROM users
WHERE pds_url = ''
  AND did NOT IN (SELECT author_did FROM shares);
