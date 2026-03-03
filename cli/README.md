# Skyreader CLI

Read and manage RSS feeds from the terminal. Designed for power users and AI agents (like Claude Code).

## Install

```bash
cd cli
npm install
```

Run commands with `npx tsx src/index.ts <command>` during development, or build and use the `skyreader` binary:

```bash
npm run build
node dist/index.js <command>
```

## Authentication

The CLI authenticates via your Bluesky account using OAuth. Login opens your browser to complete the flow.

```bash
# Login (production)
npx tsx src/index.ts login --handle you.bsky.social

# Login (local dev)
npx tsx src/index.ts login --handle you.bsky.social --server http://127.0.0.1:8787
```

Your session is stored in `~/.config/skyreader/config.json`.

Verify your session:

```bash
npx tsx src/index.ts whoami
```

## Commands

### `whoami`

Show current user info.

```bash
skyreader whoami
skyreader whoami --json
```

### `subscriptions`

List your feed subscriptions.

```bash
skyreader subscriptions
skyreader subscriptions --json
```

### `feeds`

Fetch articles from a single feed or all subscriptions.

```bash
# Single feed
skyreader feeds https://example.com/rss

# All subscribed feeds
skyreader feeds --all

# Limit articles per feed
skyreader feeds --all --limit 5

# Include article content
skyreader feeds --all --content

# Only show unread articles
skyreader feeds --all --unread

# Only show articles published after a date
skyreader feeds --all --since 2024-01-01
skyreader feeds --all --since "3 days ago"
skyreader feeds --all --since yesterday

# Combine filters
skyreader feeds --all --unread --since "1 week ago"

# JSON output (includes all fields)
skyreader feeds --all --json
```

### `saved`

List saved articles.

```bash
skyreader saved
skyreader saved --json
```

## Output Formats

By default, commands output human-readable tables and lists. Add `--json` to any command for structured JSON output, useful for piping to other tools:

```bash
# Get all article titles
skyreader feeds --all --json | jq '.feeds[].items[].title'

# Get saved article URLs
skyreader saved --json | jq '.[].url'

# Count articles per feed
skyreader feeds --all --json | jq '.feeds | to_entries[] | {feed: .key, count: (.value.items | length)}'
```

## AI Agent Usage

The CLI is designed to work well with AI agents. Use `--json` for structured output that's easy to parse:

```bash
# Fetch and summarize recent articles
skyreader feeds --all --limit 5 --json

# Get full article content for analysis
skyreader feeds https://example.com/rss --content --json

# Check subscriptions
skyreader subscriptions --json
```

## Configuration

Config is stored at `~/.config/skyreader/config.json`:

```json
{
  "server": "https://api.skyreader.app",
  "sessionId": "...",
  "handle": "you.bsky.social"
}
```

The `--server` flag on `login` sets the backend URL. This is useful for local development against `http://127.0.0.1:8787`.

## Exit Codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| 0    | Success                                   |
| 1    | General error                             |
| 2    | Not authenticated (run `skyreader login`) |

## Local Development

Prerequisites: the backend must be running via `./scripts/dev-local.sh` from the repo root.

```bash
# Start the backend + frontend
cd .. && ./scripts/dev-local.sh

# In another terminal, use the CLI
cd cli
npx tsx src/index.ts login --handle you.bsky.social --server http://127.0.0.1:8787
npx tsx src/index.ts feeds --all --limit 3
```
