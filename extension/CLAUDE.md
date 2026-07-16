# Skyreader Chrome Extension

One-click save-to-Skyreader browser extension (Manifest V3). Plain JS; the only
build step bundles the Defuddle content script (`npm run build`).

## Files

- `manifest.json` — MV3 manifest. Required host permission for
  `api.skyreader.app`; optional host permissions cover local dev and staging.
- `background.js` — service worker. All logic lives here: toolbar action,
  context menus (save link / save page), the save flow, badge feedback.
- `src/extract-entry.js` — content-script entry bundling Defuddle; built to
  `content/extract.js` (gitignored) by `npm run build` (esbuild).
- `options.html` / `options.js` — server override (staging / local dev),
  requesting the matching optional host permission on save.
- `icons/` — resized from `frontend/static/icons/icon-512.png` via
  `sips -z <size> <size>` (macOS built-in).

## How saving works

The flow mirrors `saveFromUrl` in `frontend/src/lib/stores/saves.svelte.ts`,
with one upgrade — extraction is **live-DOM first**:

1. Generate a TID rkey (copy of `frontend/src/lib/utils/tid.ts` — keep in sync).
2. **Page saves** (toolbar click, "Save page" menu): inject `content/extract.js`
   into the tab and run Defuddle against the live DOM — this sees paywalled and
   JS-rendered content the server-side extractor can't. Falls back to
   `POST /api/extract` (feed-proxy cold fetch) when the page can't be scripted
   or yields no body. **Link saves** ("Save link" menu) go straight to
   `POST /api/extract` since the page isn't open.
   The extraction result shape mirrors feed-proxy's `ExtractedArticle`
   (`feed-proxy/src/app.ts` `extractArticle`), including the
   `toValidISODate` published-date validation. Keep `defuddle` at the same
   version as `feed-proxy/package.json` so both extractors behave alike.
3. `POST /api/saved` with `{ url, rkey, source: 'url', updateContent: true,
   ...extracted fields }`. `updateContent: true` means a re-save of an
   already-saved URL **upgrades the stored content in place** (200 with
   `updated: true`) instead of 409 — the paywall fix for items saved earlier
   from a truncated feed or server stub. Backend: `handleContentUpdate` in
   `backend/src/routes/saved.ts`; tests in
   `backend/test/saved-content-update.spec.ts`.

Auth is the browser's existing `session_id` cookie (`Domain=.skyreader.app`
covers the API host; MV3 host permissions exempt extension fetches from
SameSite and CORS). There is no token storage in the extension. Injection
relies on `activeTab` + `scripting`, granted by the user's click — no broad
page host permissions.

Error handling:

- `401` → open `{frontend}/save?url=…` — the frontend's share-target page
  handles login-then-resume.
- `403` (monthly URL-save limit, scope upgrade) → same `/save` page, which
  renders proper UI for both. Content upgrades don't count against the limit.
- `409` duplicate (only when there was no content to upgrade) → treated as
  success ("Already in your Saved list").
- `503 session_refresh_pending` → one retry after 2s.
- Everything else → transient `!` badge; success is a transient `✓` badge.

## Local development

1. `npm install && npm run build` (bundles `content/extract.js` — required
   before loading).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select
   this directory.
3. To hit a local backend: extension options → API server
   `http://127.0.0.1:8787`, web app `http://127.0.0.1:5173` (grant the
   permission prompt). Log in at `http://127.0.0.1:5173` first so the
   `127.0.0.1` session cookie exists.
4. After editing `background.js`, click the reload icon on the extension card.
   Service-worker logs: "Inspect views: service worker" link on the card.

## Release

No pipeline yet. To package: `npm run build`, then
`zip -r skyreader-extension.zip . -x '*.DS_Store' -x 'node_modules/*' -x 'src/*'`
from this directory and upload to the Chrome Web Store dashboard. Bump
`version` in `manifest.json` first.
