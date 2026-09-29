# Skyreader for macOS & iOS

Native SwiftUI app for macOS 14+ and iOS 17+: sign in with an Atmosphere account,
read the timeline (offline too), keep read state in sync with the web app,
save articles, and manage feeds and folders.

## Layout

- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec. The
  `.xcodeproj` is **generated and gitignored**: run `xcodegen generate` here
  (`brew install xcodegen`) after pulling or editing the spec. Add targets,
  settings and Info.plist keys (`INFOPLIST_KEY_*`) in the spec, never in Xcode's
  UI — those edits are lost on the next generate.
- `App/` — SwiftUI sources, shared by both targets (`Skyreader-iOS`,
  `Skyreader-macOS`). Guard platform-only API with `#if os(iOS)` / `#if os(macOS)`.
  - `Session.swift` — sign-in/out, keychain, one `Library` per signed-in account.
  - `MainView.swift` — the three-column split view, menu commands and shortcuts.
  - `SidebarView` / `ArticleListView` / `ReaderView` — the three columns.
  - `ArticleWebView.swift` — the reader's `WKWebView`. **JavaScript is off** and
    links open in the browser: feed HTML is untrusted, and this is the whole
    sanitization story. Keep it that way.
- `Config/` — entitlements (the macOS target is sandboxed with outbound
  network only).
- `Packages/SkyreaderKit/` — Swift package with the API client, wire models and
  `Library` (all sync, persistence and actions). **Foundation + Observation
  only**: no SwiftUI, Security, CryptoKit or other Apple-only frameworks, so
  `swift test` runs on Linux. Anything testable without a UI belongs here.

## Commands

```bash
xcodegen generate                        # regenerate Skyreader.xcodeproj
open Skyreader.xcodeproj                 # then run Skyreader-macOS / Skyreader-iOS
cd Packages/SkyreaderKit && swift test   # kit tests (macOS or Linux)
```

## Testing against a local backend

Debug builds have a **Server** picker on the sign-in screen (Production, Staging,
Local). Native sign-in needs a backend with `routes/native-auth.ts`, so before a
backend change deploys, test against Local:

1. Run `./scripts/dev-local.sh` from the repo root (see the root CLAUDE.md for
   `backend/.dev.vars`). The backend listens on `http://127.0.0.1:8787`.
2. In the app's sign-in screen pick **Local (127.0.0.1:8787)**, then sign in with
   a real handle. The auth sheet goes to your real PDS and comes back through the
   local backend (atproto's loopback client exception).

The Mac app and the iOS Simulator both reach the Mac's `127.0.0.1`; a physical
iPhone can't. Plain HTTP to loopback is allowed by `NSAllowsLocalNetworking`
(set in `project.yml`). A server without native sign-in is refused up front
(`nativeSignInUnsupported`), rather than finishing in the web app inside the
sheet. Signing out and back in is how you switch servers.

## CI

`.github/workflows/apple-ci.yml` runs on PRs touching `apple/**`: kit tests on
Linux, then unsigned `xcodebuild` builds of both targets on `macos-15`. From a
Linux environment (e.g. a cloud Claude Code session) that macOS job is the only
proof the app compiles — install the Linux Swift toolchain to run the kit tests
locally, `swiftc -parse App/*.swift` for a syntax check, and keep `App/` code
conservative.

## How it talks to the backend

- **Sign-in** is native: the app sends `native_challenge` (base64url SHA-256 of
  a secret it keeps) to `GET /api/auth/login`, opens the returned auth URL in a
  web authentication session, and receives `skyreader://auth/callback?code=…`.
  It trades code + secret at `POST /api/auth/native/exchange` for the session id,
  which goes in the keychain. See `backend/src/routes/native-auth.ts`.
- **Auth** on every call: `Authorization: Bearer <session_id>`. 401 signs out;
  503 `session_refresh_pending` is retried (never a sign-out).
- **Library** mirrors the web client's model (`frontend/src/lib/services/feedFetcher.ts`,
  `stores/itemLabels.svelte.ts`):
  - Timeline: one global cursor (`since_seq` + `generation`) into
    `GET /api/v2/timeline`. A cold start is paged, and its cursor is committed
    only after the last page. Each feed keeps its newest 100 items (= backend
    `ARTICLE_WINDOW_PER_FEED`); saved items are exempt.
  - Read state: a set of guids. Local reads/un-reads go to a persisted outbox,
    flushed (debounced) to `mark-read-bulk` / `mark-unread` with the action time
    as `updatedAt` (the backend's last-write-wins key). Other devices' changes
    arrive via `GET /api/reading/positions`; a pending local change wins.
  - Bodies: the item's content, else `GET /api/v2/items/body` for truncated
    items, else `POST /api/extract`.
  - Subscriptions: `GET /api/records/list?collection=app.skyreader.feed.subscription`;
    folders are just the `category` string.
  - Saves live only in D1 (`/api/saved`); see the root CLAUDE.md accuracy note.
  - Everything is cached in `Application Support/Skyreader/library.json`.
- Not yet: standard.site documents (`/api/v2/documents/batch`), highlights and
  notes, linkblog sharing, channels, newsletters inbox settings, OPML import.

## Design

Follow `PRODUCT.md` and `DESIGN.md` at the repo root: calm, reading-first, the
text is the product. One Blue (`#0066cc`, `#4da6ff` at night) is the app tint;
the reader uses the article serif at 1.125rem / 1.8 on a true-white page.
