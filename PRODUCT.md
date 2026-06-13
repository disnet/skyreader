# Product

## Register

product

## Users

Skyreader's primary users are **people who read to understand** — anyone who follows many sources,
reads deeply, and wants what they read to add up to something rather than scroll past. They
subscribe widely (RSS, newsletters, social posts, YouTube, the Atmosphere), they highlight and take
notes, and they share what they read with a comment because engaging with the material is how they
think it through. A meaningful subset come from the Bluesky / AT Protocol world and value that their
reading lives on infrastructure they own — but that's a reason to _trust_ Skyreader, not the reason
they come.

Their context: reading on a phone during downtime and on a laptop at a desk, often offline or on
flaky connections (the app is a PWA with IndexedDB + a sync queue for exactly this). The job to be
done is _bring everything I read into one calm place, and help the good stuff become part of how I
think — without an algorithm deciding for me._

## Product Purpose

Skyreader is a reading app that helps you make sense of what you read. It brings everything you
follow — RSS, newsletters, social posts, YouTube, the Atmosphere — into one calm, chronological
place; gives you a focused surface to actually read and annotate it; and helps the good stuff become
part of how you think. That last step is the point: highlights and margin notes, a linkblog where
sharing-with-a-comment deepens your engagement, the linkblogs of people you trust, and integrations
with sensemaking tools like Semble and Margin.

It is built on the AT Protocol — the open "Atmosphere" — so subscriptions, saves, and shares are
portable and outlive any single app. That ownership is the **foundation, not the pitch**: it's what
makes investing your reading life here safe, the way an open library outlasts any one librarian. It
should reassure, never be the price of entry.

Success looks like a reader people open daily and trust: reading stays calm and frictionless, the
social layer feels alive without becoming a timeline, and what you read accumulates into
understanding instead of evaporating — all without forcing anyone to think about lexicons and DIDs
to read an article.

## Brand Personality

**Calm, focused, quiet.** Reading-first. The interface recedes so the article and the act of
reading come forward. Voice is plain and unhurried — direct sentences, no hype, no exclamation
points by default. Personality comes from restraint and precision, not decoration: generous
whitespace, confident typography, and a quiet confidence that the product knows what it's for.

The emotional goal is _clarity and ease_ — the calm of a quiet reading room where everything you
follow comes together and the good ideas stick, rather than the anxiety of a backlog or the noise
of a feed. Ownership underwrites that calm: it's yours, so it's safe to settle in.

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
2. **Reading should add up.** The work isn't done when the article is read — it's done when it
   becomes part of how the reader thinks. Highlighting, annotating, sharing-with-a-note, and handing
   off to sensemaking tools are first-class, designed to make engagement easy rather than a chore.
   What a reader collects should feel like it accumulates into understanding, not a graveyard of saves.
3. **Ownership is the foundation, not the headline.** Reading lives on infrastructure the user owns
   (AT Protocol / the Atmosphere), which makes it portable and durable — and that's exactly why no
   one should need to understand DIDs or lexicons to read. Surface portability where it reassures
   (sync status, "this lives in your PDS"); lead with reading everywhere else, and hide the machinery.
4. **Social is present, not a feed.** Shares, notes, and read positions from followed accounts
   enrich the reading experience; they never become an algorithmic timeline. Social cues are quiet,
   chronological, and human-scaled.
5. **Offline is a first-class state, not an error.** Flaky connections are the normal case. Offline,
   syncing, and stale states are designed deliberately — never a jarring failure overlay.
6. **Density with breathing room.** Serve people tracking many feeds: scannable, keyboard-friendly,
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
