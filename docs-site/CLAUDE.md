# docs-site

User-facing documentation for Skyreader, served at `docs.skyreader.app` (staging:
`staging-docs.skyreader.app`). Astro + Starlight, fully static, deployed to Cloudflare Pages via
`.github/workflows/docs-deploy.yml` (staging on push to main, production on release — same pattern
as linkblog-site).

## Commands

```bash
npm run dev       # Dev server on port 5176 (5175 belongs to linkblog-site)
npm run build     # Static build → dist/ (writes public/version.json for the smoke check)
npm run check     # astro check + prettier
npm run preview   # Preview the built site
```

## Structure

- `src/content/docs/` — the pages, plain Markdown with Starlight frontmatter (`title`,
  `description`). The sidebar is defined in `astro.config.mjs`; adding a page means adding both.
- `src/styles/skyreader.css` — maps Starlight's theme tokens onto the root DESIGN.md palette. Any
  color change starts from DESIGN.md, not from here.
- `public/favicon.svg` — copy of `frontend/static/icons/icon-512.svg`.

## Screenshots

Screenshots on guide pages live in `src/assets/screenshots/` and are **generated, not
hand-captured**. From the repo root:

```bash
npm run shots:docs   # regenerates every screenshot (Playwright, e2e stack)
```

The specs live in `e2e-docs/` (config: `playwright.docs-shots.config.ts`) and reuse the e2e
fixtures — same prerequisites as `npm run test:e2e` (`backend/.dev.vars` with `E2E_TEST_MODE=true`,
or already-running dev servers). Rerun after a design change and commit the regenerated PNGs with
it. A new screenshot means a new test in `e2e-docs/docs-screenshots.spec.ts` that writes into
`src/assets/screenshots/`, plus the markdown embed.

## Writing rules (these are load-bearing)

The docs are user-facing copy. Everything in the root CLAUDE.md "Copy & Voice" section applies,
plus:

- **Voice:** calm, terse, reading-first. Short clauses. Let the user act; never oversell. No
  exclamation points, no marketing superlatives.
- **No em-dashes** in copy. Restructure the sentence instead.
- **Atmosphere framing:** the AT Protocol ecosystem is "the Atmosphere"; syncing to a PDS is
  "Atmospheric sync". Lead with portability, not protocol jargon. `PDS` is fine as a concrete noun
  once the framing is established.
- **Data accuracy (never get this wrong):**
  - By default everything is stored privately on Skyreader's servers.
  - Atmospheric sync covers **subscriptions only**, and makes them backed up, portable, and
    **publicly visible**. Always surface the public-visibility tradeoff.
  - **Saves never live on the PDS.** They are private to Skyreader unless the user backs them with
    Semble or Margin, which makes the whole Saved list a public collection.
- **Docs ride feature PRs.** A behavior change and its doc change belong in the same PR. When a
  feature described here changes, update the page in the same commit.
- Pages the app links to (via the frontend's help-link constants) must keep their URLs stable;
  prefer adding a redirect over breaking a slug.
