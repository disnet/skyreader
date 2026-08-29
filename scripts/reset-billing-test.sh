#!/bin/bash

# Reset a billing test account in both systems:
#   1. Deletes the Polar SANDBOX customer keyed by the account's DID
#      (external_customer_id), cancelling its subscriptions.
#   2. Clears the entitlement in the local D1 users row (tier back to 'free').
#
# Usage:
#   ./scripts/reset-billing-test.sh <did-or-handle>
#
# Token: set POLAR_SANDBOX_TOKEN (needs the customers:write scope), or the
# script falls back to POLAR_ACCESS_TOKEN from backend/.dev.vars — but only
# when that file also says POLAR_SERVER=sandbox. It refuses to touch a
# production token: this script deletes customers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$ROOT_DIR/backend"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ $# -ne 1 ]; then
    echo "Usage: $0 <did-or-handle>" >&2
    exit 1
fi
ACCOUNT="$1"

d1() {
    npx --prefix "$BACKEND_DIR" wrangler d1 execute skyreader --local --json \
        --config "$BACKEND_DIR/wrangler.toml" --command "$1"
}

# Accept a handle for convenience; resolve it to the DID that keys both systems.
if [[ "$ACCOUNT" == did:* ]]; then
    DID="$ACCOUNT"
else
    DID=$(d1 "SELECT did FROM users WHERE handle = '$ACCOUNT'" |
        node -e "const r=JSON.parse(require('fs').readFileSync(0));process.stdout.write(r[0]?.results?.[0]?.did ?? '')")
    if [ -z "$DID" ]; then
        echo -e "${RED}No local user with handle '$ACCOUNT'${NC}" >&2
        exit 1
    fi
    echo "Resolved $ACCOUNT -> $DID"
fi

# --- 1. Polar sandbox -------------------------------------------------------
TOKEN="${POLAR_SANDBOX_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$BACKEND_DIR/.dev.vars" ]; then
    if grep -q '^POLAR_SERVER=sandbox' "$BACKEND_DIR/.dev.vars"; then
        TOKEN=$(grep '^POLAR_ACCESS_TOKEN=' "$BACKEND_DIR/.dev.vars" | cut -d= -f2-)
    else
        echo -e "${RED}backend/.dev.vars is not pointed at the Polar sandbox;" \
            "refusing to use its token. Set POLAR_SANDBOX_TOKEN instead.${NC}" >&2
        exit 1
    fi
fi
if [ -z "$TOKEN" ]; then
    echo -e "${RED}No sandbox token: set POLAR_SANDBOX_TOKEN or configure" \
        "backend/.dev.vars for the sandbox.${NC}" >&2
    exit 1
fi

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
    "https://sandbox-api.polar.sh/v1/customers/external/$DID" \
    -H "Authorization: Bearer $TOKEN")
case "$STATUS" in
204 | 200) echo -e "${GREEN}Polar sandbox: customer deleted${NC}" ;;
404) echo -e "${YELLOW}Polar sandbox: no customer for this DID (already clean)${NC}" ;;
*)
    echo -e "${RED}Polar sandbox: delete failed (HTTP $STATUS)${NC}" >&2
    exit 1
    ;;
esac

# --- 2. Local D1 ------------------------------------------------------------
CHANGES=$(d1 "UPDATE users SET tier='free', tier_source=NULL, polar_customer_id=NULL, updated_at=unixepoch() WHERE did='$DID'" |
    node -e "const r=JSON.parse(require('fs').readFileSync(0));process.stdout.write(String(r[0]?.meta?.changes ?? 0))")
if [ "$CHANGES" -gt 0 ]; then
    echo -e "${GREEN}Local D1: tier reset to free${NC}"
else
    echo -e "${YELLOW}Local D1: no user row for this DID (nothing to reset)${NC}"
fi
