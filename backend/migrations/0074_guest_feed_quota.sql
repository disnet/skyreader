-- Guest reading mode: the global daily ceiling on new guest-warmed feeds, as an
-- atomic counter.
--
-- It was a COUNT over `feeds` taken just before the insert, which is a
-- check-then-act: a burst of concurrent warms could all observe capacity and
-- then each create a distinct feed, overshooting the ceiling by the size of the
-- burst. Since every one of those requests also makes the proxy fetch a
-- caller-chosen URL, the ceiling has to hold under exactly the concurrency an
-- abusive client would use.
--
-- One row per UTC day (`unixepoch() / 86400`), incremented by a single
-- conditional upsert (`DO UPDATE ... WHERE used < cap`) that reports through
-- RETURNING whether THIS caller took the slot. One statement, so the read and
-- the write cannot be interleaved.
--
-- The counter is reserved before the feed row is created and released if the
-- create turns out to be a no-op (a concurrent caller got there first), so it
-- only ever drifts conservatively: a worker that dies mid-request burns a slot
-- rather than leaking one, and the count resets at UTC midnight regardless.
CREATE TABLE guest_feed_quota (
    day  INTEGER PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0
);
