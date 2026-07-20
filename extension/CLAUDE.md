# Skyreader Chrome Extension

Save-to-Skyreader and subscribe-to-feeds browser extension (Manifest V3). Plain
JS; the only build step bundles the Defuddle content script (`npm run build`).

## Files

- `manifest.json` — MV3 manifest. The toolbar action opens `popup.html`
  (`action.default_popup`). Required host permission for `api.skyreader.app`;
  optional host permissions cover local dev and staging.
- `background.js` — service worker. All logic lives here: the save flow,
  the subscribe flow, feed discovery, context menus (save link / save page),
  badge feedback, and a `chrome.runtime.onMessage` router the popup drives.
- `popup.html` / `popup.js` — the toolbar popup. Offers "Save this page" plus
  Subscribe buttons for any feeds discovered on the page. Pure UI + messaging;
  it calls no APIs directly — everything routes through the service worker so
  one place owns the session cookie and auth handling.
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
2. **Page saves** (popup "Save this page", "Save page" menu): inject `content/extract.js`
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
relies on `activeTab` + `scripting`, granted by opening the popup (a user
gesture on the action) — no broad page host permissions.

## How subscribing works

The popup mirrors the frontend's `AddFeedModal`:

1. **Discovery** is live-DOM first, like saving. `background.js` runs two probes
   in parallel and merges them (`discoverFeeds`):
   - a content-script scan of the tab's `<link rel="alternate">` RSS/Atom tags
     (`discoverFeedLinksInTab`) — sees feeds on JS-rendered pages the cold fetch
     misses, and carries the `<link title>` and the `<link type>` (the
     authoritative RSS-vs-Atom `format`);
   - `GET /api/v2/feeds/discover?url=<page>` (`discoverViaBackend`) — cold-fetches
     for RSS feeds **and** resolves+verifies a `standard.site` publication via
     its `.well-known` endpoint (that verification is backend-only). Returns
     `{ feeds: string[], standardSite: { did, publicationUri, name, url, iconUrl } | null }`.
   DOM feeds win on de-dupe (`normalizeFeedUrl`) and keep their `format`;
   backend-only feeds get a URL-guessed `format` (`inferFormatFromUrl`).
   `discoverFeeds` also fetches `GET /api/subscriptions` (`fetchSubscriptions`)
   and marks each feed/publication `subscribed` (RSS by normalized feedUrl,
   standard.site by DID or publicationUri).
   **Presentation** (popup.js): standard.site is listed first (preferred) as a
   tinted card with the `standard-site` logo avatar + a filled "standard.site"
   badge (the `<symbol>` in popup.html); RSS/Atom rows get a muted outlined
   `RSS`/`Atom` tag so the two near-identical feeds a page often advertises are
   tellable apart. Brand color is One Blue `#0066cc`, not the web app's `#0085ff`
   (DESIGN.md drift). Already-subscribed rows render a disabled green
   "Subscribed ✓" instead of a Subscribe button (re-subscribing would silently
   un-park a parked feed).
2. **Subscribe** (`performSubscribe`) `POST /api/subscriptions` with a fresh TID
   `rkey`:
   - RSS: `{ rkey, feedUrl, title, siteUrl }`.
   - standard.site: `{ rkey, feedUrl: publicationUri, sourceType: 'atproto.documents',
     subjectDid: did, siteUrl, customIconUrl }` — matching `addStandardSite`.
   The backend uses `INSERT OR REPLACE`, so re-subscribing is idempotent (no 409).
   `403 subscription_limit_reached` → the row shows "Feed limit"; `401` → open the
   web app to log in.

## Already-saved / already-subscribed state

The extension has no local cache, so it reads state from two lightweight backend
GETs (added for it, but generally useful):

- `GET /api/saved/status?url=` → `{ saved }` (exact-URL match, same as the
  pre-save dedup gate). The popup calls it on open (`refreshSavedState`, parallel
  with discovery); when saved, the primary button flips to an outlined green
  "Saved ✓" — **still enabled**, since a re-save upgrades the stored content in
  place (the `updateContent` paywall fix).
- `GET /api/subscriptions` → `{ subscriptions: [{ feedUrl, subjectDid, sourceType,
  active }] }` (all rows incl. parked). Used by `discoverFeeds` for the
  `subscribed` flags above.

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

No pipeline yet. To package: run `npm run package` from this directory — it
rebuilds `content/extract.js` (`npm run build`) and produces
`skyreader-extension.zip` (excludes `node_modules/`, `src/`, dev files, and
dotfiles). Upload the zip to the Chrome Web Store dashboard. Bump `version` in
`manifest.json` first.
