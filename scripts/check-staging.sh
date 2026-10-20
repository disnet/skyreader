#!/usr/bin/env bash
# Refuse a release unless staging already runs everything it would ship.
#
#   GH_TOKEN=… GITHUB_REPOSITORY=disnet/skyreader scripts/check-staging.sh <sha>
#
# For each *-deploy.yml: find the last commit at or before <sha> that touched the
# workflow's push paths, then require the workflow's most recent main run (push or
# workflow_dispatch, i.e. a staging deploy) to have succeeded on that commit or a
# later one. A package nobody changed passes on its earlier green deploy; one
# changed but not yet staged, still deploying, or red on staging fails.
set -euo pipefail

sha=${1:?usage: check-staging.sh <sha>}
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
cd "$(git rev-parse --show-toplevel)"
workflows=(.github/workflows/*-deploy.yml)
set -f # from here on, the paths are globs for git, not for the shell

failed=0
for wf in "${workflows[@]}"; do
  name=$(basename "$wf")
  paths=$(grep -m1 -E '^ +paths:' "$wf" | sed -E "s/.*\[(.*)\].*/\1/" | tr -d "' " | tr ',' ' ')
  if [ -z "$paths" ]; then
    echo "::error::$name has no push paths filter to check against."
    failed=1
    continue
  fi

  last=$(git log -1 --format=%H "$sha" -- $paths)
  [ -n "$last" ] || continue

  run=$(gh api "repos/$repo/actions/workflows/$name/runs?branch=main&per_page=30" \
    --jq '[.workflow_runs[] | select(.event == "push" or .event == "workflow_dispatch")][0]
          | select(. != null) | "\(.head_sha) \(.status) \(.conclusion) \(.html_url)"')
  read -r run_sha status conclusion url <<<"${run:-}" || true

  if [ -z "${run_sha:-}" ]; then
    echo "::error::$name: no staging run on main found."
    failed=1
  elif ! git merge-base --is-ancestor "$last" "$run_sha" 2>/dev/null; then
    echo "::error::$name: staging hasn't deployed ${last:0:7} yet (latest run is on ${run_sha:0:7}). Wait for its push run to start."
    failed=1
  elif [ "$status" != completed ]; then
    echo "::error::$name: staging deploy still running: $url"
    failed=1
  elif [ "$conclusion" != success ]; then
    echo "::error::$name: staging deploy ended $conclusion. Fix it, or re-run it from Actions, then release: $url"
    failed=1
  else
    echo "$name: green on ${run_sha:0:7}"
  fi
done

exit "$failed"
