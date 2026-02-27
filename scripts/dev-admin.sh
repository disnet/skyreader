#!/bin/bash

# Local development script for the admin panel
# Reads from the same local D1 database as the backend

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ADMIN_DIR="$ROOT_DIR/admin"
BACKEND_DIR="$ROOT_DIR/backend"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Check that the backend has a local D1 database
if [ ! -d "$BACKEND_DIR/.wrangler/state" ]; then
    echo -e "${RED}No local D1 database found.${NC}"
    echo "Run the backend at least once first to create the local database:"
    echo "  cd backend && npm run dev"
    exit 1
fi

echo -e "${GREEN}Starting admin panel...${NC}"
echo -e "Using local D1 database from backend/.wrangler/state"
echo -e "Admin panel: ${GREEN}http://127.0.0.1:5174${NC}\n"

cd "$ADMIN_DIR"
npm run dev
