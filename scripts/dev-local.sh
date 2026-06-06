#!/bin/bash

# Local development script
# Uses Vite proxy so frontend and API are same-origin (cookies work without tunnel)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
FEED_PROXY_DIR="$ROOT_DIR/feed-proxy"
LINKBLOG_DIR="$ROOT_DIR/linkblog-site"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Shutting down...${NC}"
    kill $FEED_PROXY_PID 2>/dev/null || true
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    kill $LINKBLOG_PID 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Check for required .dev.vars
if [ ! -f "$BACKEND_DIR/.dev.vars" ]; then
    echo -e "${RED}Missing $BACKEND_DIR/.dev.vars${NC}"
    echo "Create it with:"
    echo "  FRONTEND_URL=http://127.0.0.1:5173"
    exit 1
fi

echo -e "${GREEN}Starting local development environment...${NC}\n"

# Run D1 migrations
echo -e "${YELLOW}[0/4] Running D1 migrations...${NC}"
cd "$BACKEND_DIR"
if ! echo "y" | npx wrangler d1 migrations apply skyreader --local; then
    echo -e "${RED}Failed to apply migrations${NC}"
    exit 1
fi
echo -e "${GREEN}Migrations applied.${NC}\n"

# Start feed proxy (no auth needed locally)
echo -e "${YELLOW}[1/4] Starting feed proxy...${NC}"
cd "$FEED_PROXY_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
bun run dev &
FEED_PROXY_PID=$!
sleep 2

# Start backend
echo -e "${YELLOW}[2/4] Starting backend...${NC}"
cd "$BACKEND_DIR"
npm run dev &
BACKEND_PID=$!
sleep 2

# Start frontend (Vite proxies /api to backend)
echo -e "${YELLOW}[3/4] Starting frontend...${NC}"
cd "$FRONTEND_DIR"

# Ensure no VITE_API_URL is set (use Vite proxy for same-origin)
if [ -f .env ]; then
    grep -v "^VITE_API_URL=" .env > .env.tmp 2>/dev/null || true
    mv .env.tmp .env 2>/dev/null || true
fi

npm run dev &
FRONTEND_PID=$!

# Start the public linkblog site (standalone SvelteKit app, port 5175). Reads the
# feed proxy at runtime; the subscribe button hits the backend cross-origin (CORS +
# session cookie are configured for 127.0.0.1:5175 in backend/.dev.vars).
echo -e "${YELLOW}[4/4] Starting linkblog site...${NC}"
cd "$LINKBLOG_DIR"
npm run dev &
LINKBLOG_PID=$!

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}Development environment ready!${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "Feed proxy: http://127.0.0.1:3000"
echo -e "Backend:    http://127.0.0.1:8787"
echo -e "Linkblogs:  http://127.0.0.1:5175/<did-or-handle>"
echo -e ""
echo -e "${GREEN}Open in your browser:${NC}"
echo -e "${GREEN}  http://127.0.0.1:5173${NC}"
echo -e ""
echo -e "(Vite proxies /api to backend - same origin, cookies work)"
echo -e "\nPress Ctrl+C to stop all services\n"

# Wait for any process to exit
wait
