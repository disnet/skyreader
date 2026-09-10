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
  (`src/lib/server/identity.ts`); publication metadata from the user's PDS; the
  linkblog's target publication and its posts from the Skyreader API
  (`src/lib/server/api.ts`). Best-effort, but "couldn't ask" is not "nothing here":
  `fetchLinkblogDocuments` returns `null` on a failure, the HTML pages fail open to
  an empty shell, and **`feed.xml` answers 503 + `no-store`** rather than a cached
  empty channel that readers record as every entry having been deleted.
- **No feed-proxy dependency.** `GET /api/linkblog/documents/<did>` returns the
  posts already scoped to the author's publications, filtered to link posts and
  ordered newest-shared-first, so this app holds no copy of those rules. It used
  to: the proxy returned documents and this app scoped and filtered them, which put
  two copies of the record mapper on two deploy cadences — and a `links` union the
  older one didn't understand blanked a linkblog with no error anywhere.
  Constellation social context (recommend/quote counts, "also linked by") was
  dropped rather than ported; it was the last thing here reaching past the API.
- Browser-side: only the **subscribe button** (`SubscribeActions.svelte`) is
  interactive. It calls the backend API (`api.skyreader.app`) cross-origin but
  same-site, so the session cookie rides the credentialed fetch; the linkblog
  origin is in the backend's `ALLOWED_ORIGINS`.
- Pure helpers shared by load functions and components live in `src/lib/fields.ts`.

## Environment

Read via `$env/dynamic/private` (so do **not** use the `PUBLIC_` prefix). There are
**no secrets** — every backing service this app reads is public.

- `API_URL` / `APP_URL` — optional overrides; otherwise derived from the request
  host (`apiBaseFor` / `appUrlFor`).

**Nothing goes in `wrangler.toml` `[vars]`.** Both Pages projects deploy from the
same file, so a var set there lands on both — that is how staging came to read from
the _production_ feed proxy back when documents came from there. Derive from the
host instead.

Local dev needs no `.env` at all: `127.0.0.1` derives the local backend on 8787.
Copy `.env.example` to `.env` only to override.

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
