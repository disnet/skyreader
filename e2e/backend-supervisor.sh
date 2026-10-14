#!/usr/bin/env bash
# Runs the backend's `wrangler dev` for Playwright and starts it again if it
# exits. wrangler dev has been crashing mid-run in CI (a bare "✘ [ERROR]" after a
# few workerd "Broken pipe" lines), and Playwright's webServer never restarts a
# dead server, so one crash used to fail every test left in the shard. Local D1
# state lives on disk under backend/.wrangler, so a restart loses nothing; the
# test fixtures wait for /api/health before seeding (see e2e/seed.ts).
#
# Playwright stops this script by killing its whole process group, which takes
# the running wrangler with it.
set -u

cd "$(dirname "$0")/../backend"

MAX_RESTARTS=5
restarts=0
# Our process group: Playwright starts this script as a group leader, and
# whatever a dead wrangler leaves behind (its own child process, workerd) stays in
# the group even once reparented.
pgid=$(ps -o pgid= $$ | tr -d ' ')

while true; do
  npm run dev
  status=$?
  # Clear leftovers holding port 8787 before starting a fresh wrangler.
  pkill -9 -g "$pgid" -f 'wrangler|workerd' 2>/dev/null
  sleep 1
  if [ "$restarts" -ge "$MAX_RESTARTS" ]; then
    echo "[backend-supervisor] wrangler dev exited ($status); gave up after $MAX_RESTARTS restarts" >&2
    exit "$status"
  fi
  restarts=$((restarts + 1))
  echo "[backend-supervisor] wrangler dev exited ($status); restart $restarts of $MAX_RESTARTS" >&2
done
