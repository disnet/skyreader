# Skyreader Browser Extension

Save-to-Skyreader and subscribe-to-feeds browser extension (Manifest V3), for
Chrome, Firefox, and Safari from one source tree. Plain JS; the only build step
bundles the Defuddle content script (`npm run build`). Safari additionally needs
a native app wrapper around the packaged extension — see Safari below.

## Files

- `manifest.json` — MV3 manifest, and the **source** manifest for every browser:
  it carries both background keys and the Gecko add-on id so this directory
  loads unpacked in any of them. Store builds get a target-specific manifest (see
  Release). The toolbar action opens `popup.html` (`action.default_popup`).
  Required host permission for `api.skyreader.app`; optional host permissions,
  storage permission, and the options page cover local development only and are
  omitted from the store ZIPs.
- `background.js` — the background script. All logic lives here: the save flow,
  the subscribe flow, feed discovery, context menus (save link / save page),
  badge feedback, and a `runtime.onMessage` router the popup drives. It runs as
  a service worker in Chrome and a non-persistent event page in Firefox and
  Safari, so every listener is registered at the top level and nothing is
  expected to survive a restart.
- `popup.html` / `popup.js` — the toolbar popup. Offers "Save this page" plus
  Subscribe buttons for any feeds discovered on the page. Pure UI + messaging;
  it calls no APIs directly — everything routes through the service worker so
  one place owns the session cookie and auth handling.
- `src/extract-entry.js` — content-script entry bundling Defuddle; built to
  `content/extract.js` by `npm run build` (esbuild) for unpacked development,
  and rebuilt straight into the staging tree by `scripts/package.mjs` for each
  store build (Chrome minified, Firefox not — see Release).
- `scripts/manifest.mjs` — per-target manifest transforms (`manifestFor`),
  pinned by `test/manifest.test.cjs`.
- `scripts/package.mjs` — builds one store ZIP: `node scripts/package.mjs
[chrome|firefox|safari]`.
- `options.html` / `options.js` — local development server override,
  requesting the matching optional host permission on save. Unpacked only;
  store builds use fixed production URLs and never read stored overrides.
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

The popup's account section checks `GET /api/auth/me` on every open, including
on pages that cannot be saved. It shows the current handle as a link to the
configured Skyreader web app, opening in a new tab. A confirmed 401 shows a
**Log in to Skyreader** link to `/auth/login`; other errors offer a retry.
Account management happens in the web app. The extension only reads the shared
session and does not store accounts or tokens.

Run `npm test` (Node's built-in test runner) for the account-message and
host-access regression tests, plus the per-target manifest transforms.

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
     `403 subscription_limit_reached` → the row becomes a "Feed limit" button that
     opens `/supporter` (the row's single click listener dispatches on
     `btn.dataset.action`, so the button can change jobs without stacking a second
     listener on top of the first); `401` → open the web app to log in.

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
- `permission` (no host access to the API) → context menus hand off to the
  `/save` page; the popup shows its grant prompt. See below.
- Everything else → transient `!` badge; success is a transient `✓` badge.

## Cross-browser notes

One source tree serves all three browsers. The differences that actually matter:

- **API namespace.** Every script binds `const api = globalThis.browser ??
globalThis.chrome`. Firefox's `chrome` alias is callback-style, and this code
  awaits everything; `browser` is promise-based in Firefox, Safari, and Chrome
  148+. Never write a bare `chrome.` call.
- **Background.** Chrome runs `background.js` as a service worker, Firefox and
  Safari as a non-persistent event page (Firefox has no extension service
  workers; Safari has them but the store build ships one background key, and the
  event page is the lifecycle this code has already been exercised under). All
  unload when idle, so listeners stay top-level and no module state is durable.
  The 4-second `flashBadge` timer is best-effort everywhere; a lost timer leaves
  a stale badge, nothing worse.
- **Not every action API exists everywhere.** `action.setBadgeTextColor` is
  optional-chained because Safari doesn't implement it (the badge just uses the
  browser's own text color), and `contextMenus` registration is guarded by an
  existence check because iOS/iPadOS Safari has no context menus at all. Same
  defensive shape for anything else that turns out to be missing: degrade the
  affordance, don't throw in a top-level listener.
- **Host permissions are revocable in Firefox and Safari.** MV3 lets the user
  withdraw `api.skyreader.app` from `about:addons` at any time (Safari: Safari →
  Settings → Extensions → Skyreader, where host access is per-site Ask / Allow
  and is not granted at install), and a dev build pointed at `127.0.0.1` holds
  only an optional permission. Without it every fetch fails as an opaque network
  error, so `hasApiAccess` (background) and the popup's grant prompt gate the API
  up front. `performSave` / `performSubscribe` return `status: 'permission'`
  rather than attempting the call. The popup's prompt adds a Safari-only line
  pointing at those settings (`IS_SAFARI` in `popup.js` — UA sniffing, because a
  web extension has no cleaner engine signal), and reuses it as the copy when a
  Safari `permissions.request()` comes back denied.
- **`permissions.request` needs a live user gesture.** Firefox drops the gesture
  across an `await`, so `request()` must be the first `await` in a click
  handler. That is why `popup.js` captures `apiOrigin` at init, and why
  `options.js` calls `request()` with no `permissions.contains()` check ahead of
  it (`request()` resolves true without prompting when already granted).
- **The session cookie.** `session_id` is `SameSite=Lax` on `.skyreader.app`
  (`backend/src/routes/auth.ts`). Every browser here treats an extension's fetch
  as first-party for a host it holds permission for, which is what exempts these
  calls from SameSite and CORS. If that ever stops holding — Safari is the one
  most likely to break it — the symptom is a blanket 401 from `/api/auth/me`
  with the permission granted, and the fix is on the backend
  (`SameSite=None; Secure`), not here. Do not try to fix it by allowlisting the
  extension origin in CORS: both Firefox's `moz-extension://` UUID and Safari's
  `safari-web-extension://` origin are per-install.

## Safari

Safari runs the same source tree, plus two things the other browsers don't need:

- **A native app wrapper.** A Safari web extension ships inside a macOS app,
  distributed through the App Store (or a notarized Developer ID build).
  `xcrun safari-web-extension-converter` generates that wrapper from a staged
  extension directory; the extension resources it wraps are `dist/safari/`, which
  `npm run package:safari` writes. See Release for the exact invocation and the
  resource-refresh loop. **macOS only** — the converter and Xcode aren't
  available anywhere else, so this part of the build can't run in CI on Linux.
- **A consent model closer to Firefox's than Chrome's.** Host access to
  `api.skyreader.app` is not granted at install; the user allows it (per-site or
  for all sites) from Safari's extension settings. The existing
  `status: 'permission'` plumbing already covers this — the only Safari-specific
  code is the prompt copy noted above.

Scope today is **macOS Safari**. iOS/iPadOS is a separate effort: the popup
layout, the missing `contextMenus` API (already guarded), and stricter ITP around
the session cookie all need their own pass.

## Local development

1. `npm install && npm run build` (bundles `content/extract.js` — required
   before loading).
2. Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select this directory. Firefox: `about:debugging#/runtime/this-firefox` →
   **Load Temporary Add-on** → pick `manifest.json` in this directory. Both work
   off the source manifest, which carries each browser's background key (Chrome
   logs a warning about the one it ignores).
3. To hit a local backend: extension options → API server
   `http://127.0.0.1:8787`, web app `http://127.0.0.1:5173` (grant the
   permission prompt). Log in at `http://127.0.0.1:5173` first so the
   `127.0.0.1` session cookie exists.
4. After editing `background.js`, reload the extension: the reload icon on the
   Chrome extension card, or **Reload** in `about:debugging`. Logs: "Inspect
   views: service worker" in Chrome, **Inspect** in `about:debugging` for
   Firefox.

`npm run start:firefox` launches a scratch Firefox profile with the extension
loaded (`web-ext run`), if you'd rather not reload by hand.

**Safari** (macOS, Xcode required) is a longer loop, because there's no unpacked
load: build the wrapper app from `extension/safari/` in Xcode and run it once, then
Safari → Settings → **Advanced** → _Show features for web developers_, Develop →
**Allow Unsigned Extensions** (resets every Safari restart), and enable Skyreader
in Safari → Settings → Extensions. No paid Apple account is needed for this.
Grant `api.skyreader.app` there too — Safari does not grant host access on
install. Iterate with `npm run package:safari` + rebuild in Xcode; inspect the
background page and popup from Develop → Web Extension Background Content.
Options-page overrides work the same way (Safari maps `storage.sync` to local
storage — no real syncing, which the localhost override doesn't need).

## Release

No pipeline yet. `npm run package` (Chrome) and `npm run package:firefox` build
store ZIPs; `npm run package:safari` stages resources for the committed Xcode
wrapper, and `npm run package:all` does all three. Each run stages into
`dist/<target>/` (left in place for loading unpacked, linting, or — for Safari —
building the wrapper app). The Chrome and Firefox commands also write
`skyreader-extension-<target>.zip`. All include only runtime files and omit
localhost permissions, the storage permission, and the server settings page; the
source manifest keeps settings and localhost access for unpacked development.
Bump `version` in `manifest.json` first.

Target differences, all in `scripts/manifest.mjs` and `scripts/package.mjs`:

- Chrome gets `background.service_worker` and no `browser_specific_settings`
  (Chrome reports the Gecko key as unrecognized).
- Firefox gets `background.scripts`; AMO **rejects** a manifest declaring a
  service worker even though the browser would ignore it.
- Safari gets `background.scripts` plus a `browser_specific_settings.safari`
  version floor (`SAFARI_MIN_VERSION`, 16.4 — the first release with full MV3),
  with `background.persistent: false` and the Gecko block dropped. Ship exactly
  one background script key: the converter warns about whichever it ignores.
- The Firefox content-script bundle is **not** minified, because AMO requires a
  source-code submission for minified code. It's a content script, so the size
  difference doesn't matter. Chrome and Safari (App Review asks for no such
  submission) get the minified bundle. `content/extract.js` in the working tree
  is always the minified dev build; the packager bundles into the staging tree
  instead of copying, so a Firefox build never clobbers it.
- `browser_specific_settings.gecko.data_collection_permissions` is required for
  new AMO submissions (since Nov 2025). It declares `websiteContent`: saving
  transmits the page URL and extracted article text to the user's account, on a
  user action.

`npm run lint:firefox` packages and runs `web-ext lint` on the result. Zero
errors is the bar. Two warnings are expected and fine: `UNSAFE_VAR_ASSIGNMENT`
(an `innerHTML` write inside the bundled Defuddle library) and
`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` (`strict_min_version` is 140,
the ESR, but Android only learned `data_collection_permissions` in 142; the
extension doesn't declare Android support).

Upload `skyreader-extension-chrome.zip` to the Chrome Web Store dashboard and
`skyreader-extension-firefox.zip` to addons.mozilla.org.

AMO also requires a **source code submission**, because the add-on is built with
a bundler (this applies whether or not the output is minified). `npm run
package:firefox:source` writes `skyreader-extension-firefox-source.zip`: the
sources, build scripts, and lockfile, with `AMO_REVIEW.md` copied in as
`README.md` for the reviewer's build instructions. Upload it on the same
submission step as the add-on.

The reviewer rebuilds from that package, so the build must not depend on
anything above `extension/`. That is why the esbuild invocations pass
`--tsconfig-raw={}`: without it esbuild walks up, finds the monorepo root
`tsconfig.json`, and its `strict: true` adds a `"use strict"` prologue the
reviewer's build wouldn't reproduce. To re-verify after changing the build,
unzip the source package somewhere else, run `npm ci && node
scripts/package.mjs firefox`, and `diff -r` its `dist/firefox` against yours.

### Safari: the wrapper app

Safari has no ZIP upload — the extension ships inside a macOS app. `dist/safari/`
is the input; everything below needs macOS with Xcode, and distribution needs an
Apple Developer Program membership.

The Xcode project is committed at `safari/Skyreader.xcodeproj`. Open it in Xcode,
select the Skyreader scheme, choose signing teams for both targets, and build.
The extension target's final build phase runs `npm run package:safari` and copies
the staged files into the extension bundle, so web resources cannot silently go
stale. Node and the extension's npm dependencies must be installed before the
first build.

```
npm install
open safari/Skyreader.xcodeproj
```

- The refresh build phase also reads `manifest.json` and fails when its version
  differs from `MARKETING_VERSION`. Update both targets' Marketing Version when
  bumping the manifest version.
- Keep the container app thin: the converter's stock "open Safari settings to
  enable" window, restyled with the Skyreader icon and One Blue `#0066cc`
  (DESIGN.md). Apple accepts thin container apps for extensions; don't invent
  app UI.

Distribution (Mac App Store, so the same pipeline can carry iOS later): create
the app record in App Store Connect, then archive / sign / upload from Xcode —
manual, matching the no-pipeline posture for the other two stores. The privacy
label mirrors the AMO `websiteContent` disclosure: the page URL and extracted
article text go to the user's account, on a user action. Screenshots live in
`store-assets/`. A macOS-runner GitHub Actions job (`xcodebuild archive` +
upload) is a later follow-up.

When the App Store listing goes live, the docs-site pages that tell users how to
install the extension (`guide/saving-and-highlights.md`, `guide/adding-sources.md`,
`faq.md`) need the Safari install path plus the "allow `api.skyreader.app`" grant
step — a Safari-only speed bump every user hits.
