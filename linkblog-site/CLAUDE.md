# Skyreader Linkblog Site

Standalone SvelteKit app that renders users' **public linkblogs** at
`linkblogs.skyreader.app/<did-or-handle>`. Read-only, server-rendered, deployed to
Cloudflare Pages via `@sveltejs/adapter-cloudflare`.

## Why it's a separate app

Linkblogs render user-generated content (notes, titles, "also linked by" notes from
arbitrary AT-Proto users). Hosting that on its **own origin**, isolated from the
authenticated PWA at `skyreader.app`, means an XSS here can't touch the app's
session/storage/service worker. It also keeps the PWA untouched — no
service-worker/precache entanglement. (It replaces the old Cloudflare Pages
Functions at `frontend/functions/blogs/`.)

## Routes

| Route            | File                                                          |
| ---------------- | ------------------------------------------------------------- |
| `/<id>`          | `src/routes/[id]/+page.{server.ts,svelte}` — index            |
| `/<id>/<rkey>`   | `src/routes/[id]/[rkey]/+page.{server.ts,svelte}` — permalink |
| `/<id>/feed.xml` | `src/routes/[id]/feed.xml/+server.ts` — RSS 2.0               |

`<id>` is a DID (canonical) or handle (302-redirects to the DID). The static
`feed.xml` segment outranks the sibling `[rkey]` route.

## Data flow

- Server-side: profile + handle resolution via the Bluesky public AppView
  (`src/lib/server/identity.ts`); publication metadata from the user's PDS;
  linkblog documents + social context from the Fly.io feed proxy
  (`src/lib/server/proxy.ts`). All best-effort — pages degrade to profile defaults.
- Browser-side: only the **subscribe button** (`SubscribeActions.svelte`) is
  interactive. It calls the backend API (`api.skyreader.app`) cross-origin but
  same-site, so the session cookie rides the credentialed fetch; the linkblog
  origin is in the backend's `ALLOWED_ORIGINS`.
- Pure helpers shared by load functions and components live in `src/lib/fields.ts`.

## Environment

Read via `$env/dynamic/private` (so do **not** use the `PUBLIC_` prefix):

- `FEED_PROXY_URL` — Fly.io feed proxy (set in `wrangler.toml` [vars]).
- `FEED_PROXY_SECRET` — optional `X-Proxy-Secret` (set as a Pages secret).
- `API_URL` / `APP_URL` — optional overrides; otherwise derived from the request
  host (`apiBaseFor`/`appUrlFor`).

Local dev defaults `FEED_PROXY_URL` to `http://127.0.0.1:3000`; copy `.env.example`
to `.env` to override.

## Commands

```bash
npm run dev      # Vite dev server on http://127.0.0.1:5175
npm run build    # → .svelte-kit/cloudflare
npm run preview  # wrangler pages dev of the build
npm run check    # svelte-kit sync + svelte-check + prettier --check
npm run deploy   # build + wrangler pages deploy
```

Run `npm run check` before finishing work.

## CSP

Strict, owned by SvelteKit's `kit.csp` (per-request nonce for the hydration
script) in `svelte.config.js`; other security headers in `src/hooks.server.ts`.
HTML pages are intentionally not edge-cached (the nonce must stay per-request); the
RSS endpoint caches for 5 min.

## Deploy

GitHub Actions `.github/workflows/linkblog-deploy.yml` (staging on push to main,
production on release) to Cloudflare Pages projects `skyreader-linkblog-staging` /
`skyreader-linkblog`. Production custom domain: `linkblogs.skyreader.app`.
