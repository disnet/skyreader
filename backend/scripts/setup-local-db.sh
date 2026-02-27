#!/bin/bash
# Setup local D1 database and Durable Objects for development
#
# Usage:
#   ./scripts/setup-local-db.sh         # Normal setup
#   ./scripts/setup-local-db.sh --reset # Full reset (deletes all local state)

set -e

cd "$(dirname "$0")/.."

# Handle --reset flag
if [ "$1" = "--reset" ]; then
  echo "Resetting local wrangler state..."
  rm -rf .wrangler
  echo "Local state deleted."
  echo ""
fi

# Generate types (this also validates DO migrations)
echo "Generating wrangler types..."
npx wrangler types

# Apply D1 migrations
echo ""
echo "Applying D1 migrations to local database..."
npx wrangler d1 migrations apply skyreader --local

echo ""
echo "Done! Local database is ready."
echo ""
echo "You can now run: npm run dev"
