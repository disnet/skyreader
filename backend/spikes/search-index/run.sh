#!/usr/bin/env bash
# Run the search-index spike locally: start the spike worker, seed and time
# each FTS5 variant. Usage: ./run.sh [docs]   (default 50000)
set -euo pipefail
cd "$(dirname "$0")"
WRANGLER=../../node_modules/.bin/wrangler
$WRANGLER dev --port 8799 --persist-to ./.wrangler/state > dev.log 2>&1 &
DEV=$!
trap 'kill $DEV' EXIT
until curl -s 127.0.0.1:8799/info > /dev/null; do sleep 1; done
node bench.mjs "${1:-50000}"
