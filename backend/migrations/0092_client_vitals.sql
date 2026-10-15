-- Field vitals: how responsive Skyreader is on readers' real devices, in
-- aggregate only. Each row is one bucket of one day's histogram for one metric
-- (inp, cls, blocking), route pattern and build; a page view's report only
-- increments `count`, so no individual report is ever stored and nothing here
-- identifies a reader. Percentiles are read back from the buckets (the admin
-- dashboard does). `bucket_le` is the bucket's upper bound in the metric's own
-- unit (ms, or unitless for CLS), so a reader of the table needs no bucket list.
-- Pruned at 90 days by the hourly cron. See backend/src/routes/vitals.ts.
CREATE TABLE client_vitals (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  route TEXT NOT NULL,
  app_version TEXT NOT NULL,
  bucket_le REAL NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, route, app_version, bucket_le)
);
