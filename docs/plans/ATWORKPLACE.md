# Skyreader in an atworkplace workspace

[atworkplace](https://github.com/disnet/atlauncher) is a web page that frames
atproto apps side by side, with one sidebar to pick each app's account. Apps
talk to it over postMessage (`atworkplace/1`, the repo's `docs/PROTOCOL.md`).
The full plan, with the phases after this spike, is the "Skyreader in
atworkplace: integration plan" doc.

## What the spike does (staging only)

- **Framing.** `frontend/src/lib/workspace/shells.ts` lists, per Skyreader host,
  the shells allowed in `frame-ancestors`. Only staging has one (a framed sign-in needs https, so not local dev).
  Hosts with none keep `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Sign-in from the frame, partitioned.** A framed app's cookies live in a
  partition keyed by the shell's site, and auth servers can't be framed, so
  sign-in runs in a popup whose cookie the frame would never see. Instead:
  1. The frame keeps a random relay secret and opens the popup on
     `/auth/frame-start`. The popup asks its opener for the request (handle or
     provider, plus the secret's SHA-256) by postMessage, checked same-origin
     both ways, before it navigates away and the auth server's COOP cuts the
     opener link.
  2. The popup calls `/api/auth/login` with `frame_relay_hash`. The response
     also sets a `__Host-` binding cookie in the
     popup's top-level jar.
  3. The callback parks the session (`frame_sign_in`, single use, 10 minutes)
     only if the browser finishing sign-in carries that binding cookie, and sets
     no session cookie. A relay hash can't be reused while one is pending.
  4. The frame polls `POST /api/auth/frame-claim` with the secret. The claim
     returns the session as a `SameSite=None; Secure; Partitioned` cookie.

  Steps 1 and 3 together stop the obvious attack: start a framed login with your
  own relay, send the auth URL to someone, and claim the session of whoever
  approves it. The reader's top-level cookie is never touched and stays
  `SameSite=Lax`. Unclaimed sign-ins and their sessions are deleted hourly.
  Gated by the backend's `WORKSPACE_FRAMING` var (`"true"` on staging only).

- **Cross-site write guard.** Every non-GET request carrying a session cookie is
  refused (403) when `Sec-Fetch-Site` says `cross-site`, or, without fetch
  metadata, when its web `Origin` isn't in `ALLOWED_ORIGINS`. Extension origins
  pass. This applies everywhere, not just with framing on: Lax was the only CSRF
  defence before (`backend/src/utils/cross-site.ts`).
- **Protocol.** `frontend/src/lib/workspace/bridge.svelte.ts` sends `hello` and
  `state` with the signed-in DID, answers `switch` to another account with
  `needs-sign-in`, and signs out on `sign-out`.

## Trying it

1. Open the deployed shell
   (`https://atworkplace-shell.strand-source.workers.dev`) and add a frame for
   `https://staging.skyreader.app`.
2. Sign in inside the frame. A popup runs the usual sign-in and closes; the
   frame signs in a moment later.
3. Check the shell's sidebar shows the account, and that Skyreader at top level
   is unaffected.

## Known gaps

- Permission upgrades (`/api/auth/upgrade`) still navigate the frame to the auth
  server, which refuses to be framed. Phase 1 routes them through the popup.
- One session per partition, so `switch` to another account asks for sign-in.
  Multi-account is phase 2.
- Unread counts, `at://` links, shared actions and "what links here" are phase 1.
