# Product

## Register

product

## Users

Skyreader's primary users are the **Bluesky / AT Protocol social crowd**: people who came for
data ownership and portable identity, and who treat sharing what they read as a first-class part
of the experience. They already have a Bluesky handle, understand (or appreciate) that their
subscriptions, read state, and shares live in their own PDS rather than a company's database, and
they expect the social layer — shares from people they follow, their own commentary, read
positions — to be present, not bolted on.

Their context: reading on a phone during downtime and on a laptop at a desk, often offline or on
flaky connections (the app is a PWA with IndexedDB + a sync queue for exactly this). The job to be
done is _keep up with the feeds and people I care about, on infrastructure I own, without an
algorithm deciding for me._

## Product Purpose

Skyreader is a decentralized RSS reader built on AT Protocol. It exists to give readers a fast,
ownable alternative to algorithmic feeds: subscriptions, saved articles, read state, and social
shares are stored in the user's Personal Data Server, making the entire reading life portable
across any AT Protocol client. It layers social sharing (shares, notes, read positions from
followed accounts) on top of a chronological, user-controlled reading experience.

Success looks like a reader people open daily and trust — the reading stays calm and frictionless,
the social layer feels alive without becoming a timeline, and the data-ownership promise is real
and visible without forcing the user to think about lexicons and DIDs to read an article.

## Brand Personality

**Calm, focused, quiet.** Reading-first. The interface recedes so the article and the act of
reading come forward. Voice is plain and unhurried — direct sentences, no hype, no exclamation
points by default. Personality comes from restraint and precision, not decoration: generous
whitespace, confident typography, and a quiet confidence that the product knows what it's for.

The emotional goal is _ownership and ease_ — the sense of a well-kept personal library that
belongs to you, where catching up feels relaxing rather than like clearing a backlog under duress.

## Anti-references

- **Generic SaaS dashboard.** No cards-everywhere grids, gradient accents, hero-metric templates,
  or analytics-product chrome. This is a place to read, not a control panel.
- **Cluttered legacy reader.** No dense toolbar walls, no every-feature-visible Google-Reader-clone
  density surrounding the content. Chrome stays minimal and out of the way of the text.
- **Cream / beige editorial cliché.** Avoid the warm-paper, serif-everything "magazine-warm"
  aesthetic that now reads as an AI default. Warmth, if any, is earned through typography and
  rhythm, not a sand-colored body background.
- **Algorithmic social feed.** The social layer must never feel like X / a doomscroll timeline:
  no engagement bait, no infinite-noise framing, no attention-grabbing UI competing with reading.

## Design Principles

1. **The text is the product.** Every chrome decision is measured against whether it helps or
   distracts from reading. When in doubt, remove it. The reading view is the most precious surface
   in the app and gets the most restraint.
2. **Ownership, made calm not loud.** The AT Protocol / PDS story is a core differentiator, but the
   user shouldn't need to understand DIDs or lexicons to read. Surface ownership and portability
   where it reassures (sync status, "this lives in your PDS"), hide the machinery everywhere else.
3. **Social is present, not a feed.** Shares, notes, and read positions from followed accounts
   enrich the reading experience; they never become an algorithmic timeline. Social cues are quiet,
   chronological, and human-scaled.
4. **Offline is a first-class state, not an error.** Flaky connections are the normal case. Offline,
   syncing, and stale states are designed deliberately — never a jarring failure overlay.
5. **Density with breathing room.** Serve people tracking many feeds: scannable, keyboard-friendly,
   efficient lists — but with enough whitespace and rhythm that scanning feels calm, not cramped.

## Accessibility & Inclusion

Target **WCAG 2.1 AA**, plus accommodations specific to long-form reading:

- Body text meets ≥4.5:1 contrast (≥3:1 for large text); placeholder and muted text held to the
  same bar rather than drifting into light gray.
- User-adjustable article typography is a first-class feature, not a setting afterthought: font
  family (sans / serif / mono) and size (xs–xl) are already wired through CSS custom properties and
  should stay easy to reach.
- Full keyboard navigability with visible focus states; a keyboard-shortcuts surface already exists
  and should stay discoverable.
- `prefers-reduced-motion` is honored on every animation with a crossfade or instant fallback.
- `prefers-color-scheme` light/dark is supported; both themes must independently pass contrast.
- Color is never the sole carrier of meaning (read/unread, sync state, social cues pair color with
  shape, weight, or text).
