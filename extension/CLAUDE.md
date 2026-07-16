# Skyreader Chrome Extension

One-click save-to-Skyreader browser extension (Manifest V3). No build step —
the directory is loaded directly as an unpacked extension; plain JS only.

## Files

- `manifest.json` — MV3 manifest. Required host permission for
  `api.skyreader.app`; optional host permissions cover local dev and staging.
- `background.js` — service worker. All logic lives here: toolbar action,
  context menus (save link / save page), the save flow, badge feedback.
- `options.html` / `options.js` — server override (staging / local dev),
  requesting the matching optional host permission on save.
- `icons/` — resized from `frontend/static/icons/icon-512.png` via
  `sips -z <size> <size>` (macOS built-in).

## How saving works

The flow mirrors `saveFromUrl` in `frontend/src/lib/stores/saves.svelte.ts`:

1. Generate a TID rkey (copy of `frontend/src/lib/utils/tid.ts` — keep in sync).
2. `POST /api/extract` `{ url }` → extracted article (best-effort; a failure
   still saves the bare URL with the tab title).
3. `POST /api/saved` with `{ url, rkey, source: 'url', ...extracted fields }`.
   Note the extract response uses `published`; the save body wants `publishedAt`.

Auth is the browser's existing `session_id` cookie (`Domain=.skyreader.app`
covers the API host; MV3 host permissions exempt extension fetches from
SameSite and CORS). There is no token storage in the extension.

Error handling:

- `401` → open `{frontend}/save?url=…` — the frontend's share-target page
  handles login-then-resume.
- `403` (monthly URL-save limit, scope upgrade) → same `/save` page, which
  renders proper UI for both.
- `409` duplicate → treated as success ("Already in your Saved list").
- `503 session_refresh_pending` → one retry after 2s.
- Everything else → transient `!` badge; success is a transient `✓` badge.

## Local development

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select
   this directory.
2. To hit a local backend: extension options → API server
   `http://127.0.0.1:8787`, web app `http://127.0.0.1:5173` (grant the
   permission prompt). Log in at `http://127.0.0.1:5173` first so the
   `127.0.0.1` session cookie exists.
3. After editing `background.js`, click the reload icon on the extension card.
   Service-worker logs: "Inspect views: service worker" link on the card.

## Release

No pipeline yet. To package: `zip -r skyreader-extension.zip . -x '*.DS_Store'`
from this directory and upload to the Chrome Web Store dashboard. Bump
`version` in `manifest.json` first.
