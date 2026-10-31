-- Copying saves into a reader's Semble/Margin backing collection as a queued job
-- (services/backing/copy-queue.ts), at the pace the reader's PDS allows: a big
-- import can take days, and no longer needs a tab kept open for it.

-- The saves still to copy.
CREATE TABLE IF NOT EXISTS backing_copy_pending (
  user_did TEXT NOT NULL,
  rkey TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  -- Hops whose copy of this save failed while others in it went through: a
  -- save the PDS keeps refusing is dropped after a few.
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_did, rkey)
);

-- One row per reader with a copy under way. `token` names the live chain of
-- jobs and `seq` its next hop: a hop claims the row by bumping seq, so a stale
-- chain's job, or a second delivery of the same message, stops. `next_run_at`
-- is when the next hop runs (later than now while it waits out the PDS's write
-- limit). `failures` counts hops in a row that couldn't copy anything (signed
-- out, the PDS down); at the cap the copy stops (`stalled`) until the reader
-- comes back to Settings or queues more.
CREATE TABLE IF NOT EXISTS backing_copy_runs (
  user_did TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  stalled INTEGER NOT NULL DEFAULT 0
);
