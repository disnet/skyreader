# skyreader-feed-proxy

A smart RSS/Atom feed caching proxy with selective item filtering. Fetches feeds from origins, parses them into normalized JSON, caches results, and supports returning only new items based on known GUIDs.

## Features

- **Feed Caching**: Stale-while-revalidate pattern for fast responses
- **Selective Filtering**: Return only items newer than known GUIDs
- **Multi-format Support**: RSS 2.0, Atom 1.0, JSON Feed, RDF 1.0
- **Bulk Fetching**: Fetch multiple feeds in parallel with per-feed filtering
- **Feed Discovery**: Find feed URLs from any website via HTML parsing and path probing
- **In-flight Deduplication**: Prevents duplicate simultaneous requests

## Quick Start

```bash
# Install dependencies
bun install

# Run locally
bun run dev

# Type check
bun run check
```

## API Reference

### GET /feed

Fetch a single feed with optional filtering.

```
GET /feed?url=https://example.com/feed.xml
GET /feed?url=https://example.com/feed.xml&since_guids=abc,def,ghi
GET /feed?url=https://example.com/feed.xml&since_guids=abc,def&limit=50
```

**Query Parameters:**

| Parameter     | Required | Description                                           |
| ------------- | -------- | ----------------------------------------------------- |
| `url`         | Yes      | Feed URL to fetch                                     |
| `since_guids` | No       | Comma-separated GUIDs the client already has          |
| `limit`       | No       | Max items when no GUID match (default: 100, max: 500) |

**Response Headers:**

| Header             | Values                                | Description                    |
| ------------------ | ------------------------------------- | ------------------------------ |
| `X-Cache`          | `HIT`, `STALE`, `MISS`, `REVALIDATED` | Cache status                   |
| `X-Cache-Age`      | seconds                               | Age of cached data             |
| `X-Filter`         | `MATCHED:<guid>`, `FULL`, `NONE`      | Filter result                  |
| `X-Total-Items`    | number                                | Total items in feed            |
| `X-Returned-Items` | number                                | Items returned after filtering |

**Response Body:**

```json
{
  "title": "Example Blog",
  "description": "A blog about examples",
  "siteUrl": "https://example.com",
  "imageUrl": "https://example.com/logo.png",
  "items": [
    {
      "guid": "unique-id-123",
      "url": "https://example.com/post/1",
      "title": "Post Title",
      "author": "John Doe",
      "content": "<p>Full HTML content...</p>",
      "summary": "Plain text summary...",
      "imageUrl": "https://example.com/post/1/image.jpg",
      "publishedAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "fetchedAt": 1705312200000
}
```

### POST /feeds

Bulk fetch multiple feeds with optional per-feed filtering.

**Simple format (no filtering):**

```json
POST /feeds
{
  "urls": [
    "https://example.com/feed1.xml",
    "https://example.com/feed2.xml"
  ]
}
```

**Detailed format (with filtering):**

```json
POST /feeds
{
  "feeds": [
    {
      "url": "https://example.com/feed1.xml",
      "since_guids": ["guid-a", "guid-b", "guid-c"],
      "limit": 50
    },
    {
      "url": "https://example.com/feed2.xml",
      "since_guids": ["guid-x"]
    }
  ],
  "limit": 100
}
```

**Response:**

```json
{
  "feeds": {
    "https://example.com/feed1.xml": {
      "feed": { ... },
      "cache": "HIT",
      "filter": "MATCHED:guid-a",
      "totalItems": 30,
      "returnedItems": 3
    },
    "https://example.com/feed2.xml": {
      "feed": { ... },
      "cache": "MISS",
      "filter": "FULL",
      "totalItems": 25,
      "returnedItems": 25
    }
  }
}
```

### GET /discover

Discover feed URLs from a website. Parses HTML for feed link tags and probes common feed paths.

```
GET /discover?url=https://example.com
```

**Query Parameters:**

| Parameter | Required | Description                        |
| --------- | -------- | ---------------------------------- |
| `url`     | Yes      | Website URL to discover feeds from |

**Response:**

```json
{
  "feeds": ["https://example.com/feed.xml", "https://example.com/atom.xml"]
}
```

**Discovery Process:**

1. Fetch the URL
2. If response content-type indicates a feed (RSS/Atom/XML), return the URL directly
3. Parse HTML for `<link>` tags with `type="application/rss+xml"` or `type="application/atom+xml"`
4. If no links found, probe common paths: `/feed`, `/rss`, `/atom.xml`, `/feed.xml`, `/rss.xml`, `/index.xml`

**Limits:**

- Max 10 feeds returned from HTML parsing
- Max 3 common paths probed (stops after first match)

**Error Response:**

```json
{
  "error": "Failed to fetch: HTTP 403"
}
```

### POST /extract

Fetch a URL and return cleaned, extracted article content (via [Defuddle](https://github.com/kepano/defuddle), run server-side with linkedom). Results are cached per URL for 7 days, since article content is effectively immutable — so repeat and cross-user extractions of the same article skip the fetch + parse.

```
POST /extract
Content-Type: application/json

{ "url": "https://example.com/some-article" }
```

**Response:**

```json
{
  "title": "Article Title",
  "author": "Jane Doe",
  "description": "A short summary.",
  "content": "<p>Cleaned article HTML…</p>",
  "domain": "example.com",
  "image": "https://example.com/cover.jpg",
  "published": "2026-01-02T00:00:00.000Z",
  "wordCount": 1234
}
```

`published` is normalized to ISO 8601 (or `null` if missing/implausible); all string fields are `null` when absent.

**Response Headers:**

| Header        | Description                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `X-Cache`     | `HIT` (fresh cache), `MISS` (fetched + extracted), `COALESCED` (joined an in-flight extraction) |
| `X-Cache-Age` | Age of the cached entry in seconds (on `HIT`)                                                   |

**Error Response:**

```json
{
  "error": "example.com is blocking automated access (HTTP 403)…",
  "blocked": true
}
```

### GET /health

Health check endpoint (no authentication required).

```json
{
  "status": "ok",
  "timestamp": 1705312200000,
  "cachedFeeds": 42
}
```

### GET /stats

Cache statistics (requires authentication).

```json
{
  "total": 150,
  "fresh": 80,
  "stale": 50,
  "inFlight": 2,
  "cacheTtlSeconds": 900,
  "staleTtlSeconds": 3600,
  "errors": {
    "total": 12,
    "inBackoff": 8,
    "permanent": 3
  }
}
```

## Filtering Behavior

The `since_guids` parameter enables selective item filtering to reduce bandwidth:

1. **Client sends known GUIDs**: Pass 3-5 GUIDs of items the client already has
2. **Proxy finds first match**: Scans feed items (newest first) for matching GUID
3. **Returns newer items**: Only items appearing before the match are returned

| Scenario                    | X-Filter Header  | Items Returned         |
| --------------------------- | ---------------- | ---------------------- |
| No `since_guids` provided   | `NONE`           | All items              |
| GUID found in feed          | `MATCHED:<guid>` | Items newer than match |
| No GUID found (rotated out) | `FULL`           | Up to `limit` items    |

**Example flow:**

```bash
# Initial sync - client has nothing
curl "/feed?url=..."
# Returns 30 items, X-Filter: NONE

# Client stores items, later requests update
curl "/feed?url=...&since_guids=guid-1,guid-2,guid-3"
# 2 new items since guid-1
# Returns 2 items, X-Filter: MATCHED:guid-1

# Feed moved fast, all known GUIDs rotated out
curl "/feed?url=...&since_guids=old-guid&limit=50"
# Returns 50 items (capped), X-Filter: FULL
```

## Configuration

| Environment Variable | Default  | Description                               |
| -------------------- | -------- | ----------------------------------------- |
| `PROXY_SECRET`       | (none)   | Shared secret for `X-Proxy-Secret` header |
| `DATA_DIR`           | `./data` | SQLite database location                  |
| `CACHE_TTL_SECONDS`  | `900`    | Fresh cache duration (15 min)             |
| `STALE_TTL_SECONDS`  | `3600`   | Stale cache max age (1 hour)              |
| `PORT`               | `3000`   | HTTP server port                          |
| `SENTRY_DSN`         | (none)   | Error reporting; unset ⇒ no-op            |
| `WARM_HEARTBEAT_URL` | (none)   | Dead-man ping after each warm tick        |
| `GIT_COMMIT_SHA`     | `dev`    | Build stamp, reported by `/health`        |

Observability setup, alert thresholds, and incident procedures live in
[`docs/RUNBOOK.md`](../docs/RUNBOOK.md).

## Cache Behavior

| Cache State | Age       | Behavior                    |
| ----------- | --------- | --------------------------- |
| **Fresh**   | < 15 min  | Return immediately          |
| **Stale**   | 15-60 min | Return + background refresh |
| **Expired** | > 60 min  | Fetch synchronously         |

The proxy uses HTTP conditional requests (ETag, Last-Modified) to minimize bandwidth when refreshing.

## Error Handling

The proxy implements intelligent error handling with retry logic and circuit breaker patterns.

### Error Classification

| Category        | HTTP Status Codes       | Behavior                                 |
| --------------- | ----------------------- | ---------------------------------------- |
| **Transient**   | 429, 500, 502, 503, 504 | Retry with exponential backoff           |
| **Permanent**   | 401, 403, 404, 410      | No retry for 7 days                      |
| **Recoverable** | Other 4xx errors        | Limited retries, then treat as permanent |

Network errors (timeouts, DNS failures) are treated as transient.

### Backoff Strategy

- **Base delay**: 5 minutes
- **Exponential backoff**: `min(5min × 2^errorCount, 24 hours)`
- **Permanent errors**: 7-day backoff
- **Max recoverable errors**: After 5 consecutive failures, treated as permanent

| Error Count | Backoff Duration   |
| ----------- | ------------------ |
| 1           | 5 minutes          |
| 2           | 10 minutes         |
| 3           | 20 minutes         |
| 4           | 40 minutes         |
| 5           | 1 hour 20 minutes  |
| 6+          | Capped at 24 hours |

### Circuit Breaker

When a feed is in backoff:

1. Fetch attempts are skipped entirely
2. Cached data (if available) is returned immediately
3. After backoff expires, a single fetch is attempted
4. On success, error tracking resets to zero

### Error Response in Bulk Endpoint

The `/feeds` endpoint includes error information even when returning cached data:

```json
{
  "feeds": {
    "https://failing-feed.com/rss": {
      "feed": { "title": "", "items": [] },
      "cache": "MISS",
      "filter": "LIMITED",
      "error": "HTTP 503",
      "errorCount": 3,
      "nextRetryAt": 1705315800000
    }
  }
}
```

### Stats Endpoint

The `/stats` endpoint includes error statistics:

```json
{
  "total": 150,
  "fresh": 80,
  "stale": 50,
  "inFlight": 2,
  "cacheTtlSeconds": 900,
  "staleTtlSeconds": 3600,
  "errors": {
    "total": 12,
    "inBackoff": 8,
    "permanent": 3
  }
}
```

## Deployment

### Fly.io

```bash
# Create app
fly apps create skyreader-feed-proxy

# Set secret
fly secrets set PROXY_SECRET=your-secret-here

# Deploy
fly deploy
```

### Docker

```bash
docker build -t skyreader-feed-proxy .
docker run -p 3000:3000 \
  -e PROXY_SECRET=your-secret \
  -v $(pwd)/data:/data \
  skyreader-feed-proxy
```

## Architecture

```
Client Request
     │
     ▼
┌─────────────────────────────────────────────┐
│              Hono HTTP Server               │
├─────────────────────────────────────────────┤
│  1. Auth check (X-Proxy-Secret)             │
│  2. Parse filtering params                  │
│  3. Check SQLite cache                      │
│     ├─ Fresh: return immediately            │
│     ├─ Stale: return + background refresh   │
│     └─ Miss: fetch synchronously            │
│  4. Apply GUID filtering                    │
│  5. Return filtered JSON                    │
└─────────────────────────────────────────────┘
     │
     ▼ (on cache miss/stale)
┌─────────────────────────────────────────────┐
│           Feed Fetcher                      │
│  • Conditional requests (ETag/Last-Mod)     │
│  • In-flight deduplication                  │
│  • Parse RSS/Atom/JSON Feed/RDF             │
│  • Store in SQLite cache                    │
└─────────────────────────────────────────────┘
```

## Differences from skyreader-feed-cache

This is an enhanced version of `skyreader-feed-cache` with:

| Feature                 | feed-cache | feed-proxy |
| ----------------------- | ---------- | ---------- |
| Basic caching           | ✓          | ✓          |
| GUID filtering          | ✗          | ✓          |
| Per-feed bulk filtering | ✗          | ✓          |
| Filter metadata headers | ✗          | ✓          |

Use `feed-cache` for simple caching. Use `feed-proxy` when clients need incremental updates.
