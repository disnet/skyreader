-- Copying saves into a reader's Semble/Margin backing collection as a queued job
-- (services/backing/copy-queue.ts), at the pace the reader's PDS allows: a big
-- import can take days, and no longer needs a tab kept open for it.

-- The saves still to copy.
CREATE TABLE IF NOT EXISTS backing_copy_pending (
  user_did TEXT NOT NULL,
  rkey TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  PRIMARY KEY (user_did, rkey)
);

-- One row per reader with a copy under way. `token` names the live chain of
-- jobs (a job carrying another one stops); `next_run_at` is when its next job
-- runs, later than now while it waits out the PDS's write limit.
CREATE TABLE IF NOT EXISTS backing_copy_runs (
  user_did TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  next_run_at INTEGER NOT NULL
);
