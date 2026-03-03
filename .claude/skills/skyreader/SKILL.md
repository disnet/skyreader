---
name: skyreader
description: Read and manage RSS feeds, saved articles, and subscriptions using the Skyreader CLI. Use when the user asks about their feeds, articles, saved items, subscriptions, or wants to read/browse RSS content.
allowed-tools: Bash(skyreader *)
---

# Skyreader CLI

Use the `skyreader` CLI to interact with the user's Skyreader account. The CLI must already be authenticated (via `skyreader login`).

## Commands

### Check auth status
```bash
skyreader whoami
```

### List subscriptions
```bash
skyreader subscriptions
skyreader subscriptions --json
```

### Fetch feed articles
```bash
# All subscribed feeds
skyreader feeds --all --limit 5

# Single feed by URL
skyreader feeds https://example.com/rss

# With full article content (markdown via defuddle)
skyreader feeds --all --content --limit 3

# Only unread articles
skyreader feeds --all --unread

# Articles since a date
skyreader feeds --all --since "3 days ago"
skyreader feeds --all --since yesterday
skyreader feeds --all --since 2024-01-01

# Combine filters
skyreader feeds --all --unread --since "1 week ago" --limit 10

# JSON output
skyreader feeds --all --json
```

### Saved articles
```bash
# Inbox (default - non-archived)
skyreader saved

# Archived articles
skyreader saved --archive

# All saved (inbox + archive)
skyreader saved --all

# With full article content
skyreader saved --content

# JSON output
skyreader saved --json
```

## Tips

- Always use `--json` when you need to parse or process the output programmatically.
- Use `--limit` with feeds to avoid fetching too many articles at once.
- Use `--content` to get full article text for summarization or analysis.
- Combine `--unread` and `--since` to focus on recent new content.
- When the user asks to "catch up" or "what's new", use `--unread --since "1 day ago"` or similar.
- When summarizing articles, fetch with `--content --json` for the richest data.
