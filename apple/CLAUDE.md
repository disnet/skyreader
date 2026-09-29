# Skyreader for macOS & iOS

Native SwiftUI app for macOS 14+ and iOS 17+. Early scaffold: it signs in with a
pasted session ID (debug builds only), cold-starts the timeline, and shows
articles as plain text.

## Layout

- `project.yml` — [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec. The
  `.xcodeproj` is **generated and gitignored**: run `xcodegen generate` here
  (`brew install xcodegen`) after pulling or editing the spec. Add targets,
  settings and Info.plist keys (`INFOPLIST_KEY_*`) in the spec, never in Xcode's
  UI — those edits are lost on the next generate.
- `App/` — SwiftUI sources, shared by both targets (`Skyreader-iOS`,
  `Skyreader-macOS`). Guard platform-only API with `#if os(iOS)` / `#if os(macOS)`.
- `Config/` — entitlements (the macOS target is sandboxed with outbound
  network only).
- `Packages/SkyreaderKit/` — Swift package holding the API client and wire
  models. **Foundation only**: no SwiftUI, Security, or other Apple-only
  frameworks, so `swift test` runs on Linux. Anything testable without a UI
  belongs here, not in `App/`.

## Commands

```bash
xcodegen generate                        # regenerate Skyreader.xcodeproj
open Skyreader.xcodeproj                 # then run Skyreader-macOS / Skyreader-iOS
cd Packages/SkyreaderKit && swift test   # kit tests (macOS or Linux)
```

## CI

`.github/workflows/apple-ci.yml` runs on PRs touching `apple/**`: kit tests on
Linux, then unsigned `xcodebuild` builds of both targets on `macos-15`. From a
Linux environment (e.g. a cloud Claude Code session) that macOS job is the only
proof the app compiles — install the Linux Swift toolchain to run the kit tests
locally, and keep `App/` code conservative.

## Backend contract

- Auth: `Authorization: Bearer <session_id>`, the same session the web app keeps
  in its `session_id` cookie. Native OAuth isn't built yet — the backend's
  login flow redirects to the web frontend or the CLI's localhost callback
  (`cli/src/commands/login.ts`); the app will need its own redirect
  (`ASWebAuthenticationSession` + a custom scheme or universal link).
- Timeline: `GET /api/v2/timeline` (`backend/src/routes/timeline.ts`). The
  models in `Timeline.swift` mirror its response; keep optional fields optional
  so backend additions never break decoding. Only cold start is used so far;
  incremental polling (`since_seq` + `generation`) comes with local persistence.

## Design

Follow `PRODUCT.md` and `DESIGN.md` at the repo root: calm, reading-first, the
text is the product. One Blue (`#0066cc`) is the app tint; prefer system
typography and flat surfaces.
