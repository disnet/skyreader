---
name: Skyreader
description: A calm reading app that helps you make sense of everything you read — reading-first, social without the timeline, portable by foundation.
colors:
  primary: '#0066cc'
  primary-dark: '#0052a3'
  primary-tint: '#e8f4fc'
  sky: '#4a9fd4'
  highlight: '#f5c518'
  bg: '#ffffff'
  bg-secondary: '#f5f5f5'
  text: '#333333'
  text-secondary: '#666666'
  border: '#e0e0e0'
  success: '#4caf50'
  warning: '#ff9800'
  error: '#f44336'
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: '1.25rem'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.01em'
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: '1rem'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 'normal'
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
  article:
    fontFamily: "var(--article-font, Georgia, Cambria, 'Times New Roman', serif)"
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 'normal'
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 'normal'
rounded:
  sm: '4px'
  md: '6px'
  lg: '8px'
  xl: '12px'
  pill: '999px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '16px'
  lg: '24px'
  xl: '48px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '#ffffff'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  button-primary-hover:
    backgroundColor: '{colors.primary-dark}'
    textColor: '#ffffff'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  button-secondary:
    backgroundColor: '{colors.bg-secondary}'
    textColor: '{colors.text}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  button-danger:
    backgroundColor: '{colors.error}'
    textColor: '#ffffff'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  card:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.text}'
    rounded: '{rounded.lg}'
    padding: '16px'
  input:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.text}'
    rounded: '{rounded.md}'
    padding: '8px 12px'
---

# Design System: Skyreader

## 1. Overview

**Creative North Star: "The Reading Room"**

Skyreader is a quiet place to read deeply and think clearly — open to the people you trust, closed
to the algorithm. Everything you follow comes into one calm room; the design exists to make reading
it, and making sense of it, feel unhurried and ordered. Chrome is quiet and recedes; the text you
came to read is the one element allowed to raise its voice. Every surface decision is measured
against a single question from PRODUCT.md: _does this help or distract from reading?_ When in doubt,
it goes. (The room is also _yours_ — it lives on infrastructure you own — but that's the foundation
under the calm, not something the design needs to shout.)

The system is **flat, restrained, and content-forward**. Depth is conveyed through 1px borders and
tonal background layering, not decoration — shadows appear only when something genuinely floats
above the page. Color is held in reserve: a single confident blue carries interaction, and the rest
of the interface is a disciplined neutral ramp so that an article, a highlight, or an unread marker
reads instantly. It works in both light and dark, both must independently pass contrast, and it
respects `prefers-reduced-motion` on every transition.

This system explicitly **rejects** four things, carried verbatim from PRODUCT.md's anti-references:
the cards-everywhere, gradient-accent **generic SaaS dashboard**; the dense-toolbar **cluttered
legacy reader**; the warm-paper, serif-everything **cream/beige editorial cliché**; and the
engagement-bait **algorithmic social feed**. Skyreader is a place to read and think, built to
outlast any one app.

**Key Characteristics:**

- Flat by default; depth only where things overlap.
- One blue. Color is rare and therefore meaningful.
- Neutral, near-monochrome chrome so content is the only color event.
- Reader-controlled article typography (family + size) is a first-class feature.
- Calm density: efficient for many feeds, never cramped.

## 2. Colors

A near-monochrome neutral system with one disciplined blue for interaction and a small set of
semantic signals. The point of the restraint is that when color appears, it means something.

### Primary

- **Skyreader Blue** (`#0066cc`): The single interaction color. Primary buttons, links, active
  navigation, focus rings, and the sidebar's selected state. This is the **only** blue in the
  interface — see The One Blue Rule.
- **Pressed Blue** (`#0052a3`): The darker hover/active state for primary buttons and pressed
  controls. Used only as a state shift of the primary, never as a standalone fill.
- **Wash Blue** (`#e8f4fc`): A faint blue tint for selected rows and subtle active backgrounds
  (also expressed as `rgba(0, 102, 204, 0.1)` via `--color-sidebar-active`). Carries the primary's
  hue at low intensity so selection reads without a heavy fill.

### Secondary

- **Sky Identity** (`#4a9fd4`): The "Sky" in Skyreader. Reserved for **brand/OS identity surfaces
  only** — the app icon, `theme-color`, and PWA mask-icon. It sets the lighter, airier brand note
  the OS shows around the installed app. It is **not** an in-app UI color; inside the app, the
  primary is `#0066cc`.

### Tertiary

- **Highlight Gold** (`#f5c518`): The reader's text-highlight color, applied as a translucent
  `mark` background (25% at rest, 40% on hover) over article body text. The one warm accent in the
  system, and only ever in the reading surface.

### Neutral

- **Surface** (`#ffffff` light / `#1a1a1a` dark): The base reading background. The article sits here.
- **Sunken** (`#f5f5f5` light / `#2a2a2a` dark): Secondary surface for sidebars, secondary buttons,
  and recessed panels. Tonal layering, not shadow, separates it from Surface.
- **Ink** (`#333333` light / `#e0e0e0` dark): Primary body and heading text. Meets ≥4.5:1 on Surface.
- **Muted Ink** (`#666666` light / `#999999` dark): Metadata, timestamps, secondary labels. Held to
  the 4.5:1 bar for body-sized text — never drifts into decorative light gray.
- **Divider** (`#e0e0e0` light / `#404040` dark): 1px borders, dividers, input strokes, card edges.
  The primary depth mechanism in a flat system.

### Semantic

- **Success** (`#4caf50`): Sync-complete, confirmation toasts, online status.
- **Warning** (`#ff9800`): Stale-feed and degraded-state signals.
- **Error** (`#f44336`): Failed sync, destructive actions, validation errors.

### Named Rules

**The One Blue Rule.** There is exactly one interaction blue: `#0066cc` (`--color-primary`). The
values `#2563eb`, `#3b82f6`, `#0085ff`, and `#0085ff`-as-`--color-accent` that exist in the current
code are **drift, not palette** — they are scheduled for consolidation into `--color-primary`. Never
introduce a new blue. If a surface needs a blue, it is this blue or a documented tint of it.

**The Reserved Color Rule.** Outside of the one blue and the semantic trio, the interface is
neutral. Color is an event: an unread dot, a highlight, a sync state. If a screen has more than one
non-neutral hue competing for attention (excluding semantic state), something is wrong.

## 3. Typography

**Display / Body Font:** The native system sans stack — `-apple-system, BlinkMacSystemFont,
'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif`. Skyreader uses **one UI typeface**, expressed
through weight and size rather than multiple families. It loads instantly, matches each OS, and
disappears — exactly what reader-first chrome wants.

**Article Font:** Reader-selectable via `--article-font` and the `data-article-font` attribute:
**sans** (system stack), **serif** (`Georgia, Cambria, 'Times New Roman', serif`), or **mono**
(`ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace`). Size is reader-selectable across
five steps (xs `0.75rem` → xl `1.25rem`) via `data-article-font-size`.

**Character:** Quiet and native in the chrome; reader-owned in the article. The UI never imposes a
typographic personality that competes with the text the reader chose to format.

### Hierarchy

- **Headline** (600, `1.25rem`, line-height 1.3, letter-spacing -0.01em): Page and major section
  titles. The largest type in the chrome — Skyreader does not shout with oversized display type.
- **Title** (600, `1rem`, line-height 1.4): Article titles in list/card rows, modal headers.
- **Body** (400, `1rem`, line-height 1.5): Default UI text and controls.
- **Article** (400, `1rem` default, line-height ≈1.6): The reading surface. Reader-controlled
  family and size. Cap measure at **65–75ch** for comfortable long-form reading.
- **Label** (500, `0.875rem`): Metadata, timestamps, feed names, secondary actions. Usually in
  Muted Ink, never below 4.5:1.

### Named Rules

**The One Voice Rule.** The chrome uses a single typeface family. Hierarchy comes from weight (400
vs 600) and size, never from introducing a second UI font. The only typographic variety the user
should see is the one _they_ chose for the article body.

**The No-Shout Rule.** UI headings top out around `1.25rem`. There is no hero display type; this is
a reading app, and oversized headings would be chrome competing with content.

## 4. Elevation

**Flat by default; shadow only on overlap.** Content surfaces — the feed, the article, the sidebar,
cards, rows — are flat. They separate from each other through 1px borders (Divider) and tonal
layering (Surface vs Sunken), never through resting shadows. Shadow is reserved exclusively for
elements that genuinely float above the page: modals, dropdowns, popovers, toasts, and the
pull-to-refresh affordance. In dark mode the same shadows use higher opacity (0.3–0.5 vs 0.1–0.15)
because diffuse shadow reads weakly on dark surfaces.

### Shadow Vocabulary

- **Raised** (`box-shadow: 0 2px 8px rgba(0,0,0,0.1)` light / `0.3` dark): Small floating elements —
  popover menus, tooltips, context menus.
- **Floating** (`box-shadow: 0 4px 16px rgba(0,0,0,0.15)` light / `0.4` dark): Dropdowns, toasts,
  the primary mid-level overlay.
- **Overlay** (`box-shadow: 0 8px 32px rgba(0,0,0,0.25)` light / `0.5` dark): Modals and full
  dialogs that sit above a backdrop.
- **Focus Ring** (`box-shadow: 0 0 0 2px rgba(0,102,204,0.1)`): The primary-tinted focus indicator
  on interactive elements. A glow, not a shadow, but lives in the same vocabulary.

### Named Rules

**The Flat-By-Default Rule.** A surface at rest casts no shadow. If you are adding a `box-shadow` to
a card, list row, or panel that is part of the page flow, stop — use a border or a tonal background
instead. Shadow is a signal that an element has left the page plane.

## 5. Components

Components are **refined and restrained**: modest radii, quiet state changes, no heavy fills or
bouncy motion. They are reliable and unobtrusive — the UI never competes with content.

### Buttons

- **Shape:** Gently rounded, 6px radius (`{rounded.md}`). Padding `8px 16px`, weight 500, with an
  inline-flex layout and an 8px gap for optional icons.
- **Primary:** Skyreader Blue (`#0066cc`) fill, white text. The single high-emphasis action per view.
- **Hover / Focus:** Background shifts to Pressed Blue (`#0052a3`) over a 0.2s `background-color`
  transition. Focus shows the primary-tinted Focus Ring. No transform, no scale, no bounce.
- **Secondary:** Sunken (`#f5f5f5`) fill, Ink text, 1px Divider border — for lower-emphasis actions.
- **Danger:** Error (`#f44336`) fill, white text — destructive actions only.

### Cards / Containers

- **Corner Style:** 8px radius (`{rounded.lg}`).
- **Background:** Surface (`#ffffff` / dark `#1a1a1a`).
- **Shadow Strategy:** None at rest (see Elevation). Definition comes from a 1px Divider border.
- **Border:** 1px solid Divider (`#e0e0e0` / dark `#404040`).
- **Internal Padding:** 16px (`{spacing.md}`).
- **Note:** Cards are used sparingly, for genuinely grouped content. Nested cards are forbidden;
  the feed is a list of rows, not a grid of boxes.

### Inputs / Fields

- **Style:** Full-width, 1px Divider stroke, Surface background, 6px radius, `8px 12px` padding.
- **Focus:** Border shifts to Skyreader Blue (`#0066cc`); the default outline is removed in favor
  of the border shift (and, where present, the primary-tinted Focus Ring). Never remove focus
  affordance without replacing it.
- **Error:** Error-colored helper text at `0.875rem` below the field.

### Navigation (Sidebar)

- **Style:** A 320px (resizable) Sunken-background sidebar of feed sources and channels, organized
  into expandable sections.
- **States:** Default rows in Ink/Muted Ink; hover gets a subtle Sunken shift; the **active** row
  uses the Wash Blue background (`--color-sidebar-active`) — selection by tint, not by a heavy fill
  or a colored side-stripe.
- **Mobile:** The sidebar becomes an overlay drawer; `body.sidebar-open-mobile` locks page scroll
  behind it. A bottom bar (`--bottom-bar-height: 3.5rem`) respects iOS safe-area insets.

### Reading View (Signature Surface)

- The most precious surface in the app. Article body renders with reader-chosen `--article-font`
  and `--article-font-size`, measure capped at 65–75ch, line-height ≈1.6.
- Text highlights use translucent Highlight Gold (`#f5c518`) `mark` backgrounds. This is the only
  place warm color appears, and the only color besides links inside the prose.

## 6. Do's and Don'ts

### Do:

- **Do** use exactly one interaction blue, `#0066cc` (`--color-primary`). Consolidate any
  `#2563eb` / `#3b82f6` / `#0085ff` you encounter into the token.
- **Do** keep content surfaces flat and separate them with 1px Divider borders and Surface-vs-Sunken
  tonal layering.
- **Do** reserve shadows (`Raised` / `Floating` / `Overlay`) for elements that float above the page —
  modals, dropdowns, toasts, popovers — and bump shadow opacity in dark mode.
- **Do** hold muted text (`#666666` / dark `#999999`) and placeholders to ≥4.5:1; bump toward Ink
  before reaching for a lighter gray.
- **Do** keep article measure at 65–75ch and preserve reader control over article font family and size.
- **Do** pair every color signal (unread, sync state, social cue) with shape, weight, or text — color
  is never the sole carrier of meaning.
- **Do** provide a `prefers-reduced-motion` fallback (crossfade or instant) for every transition.

### Don't:

- **Don't** build a **generic SaaS dashboard**: no cards-everywhere grids, gradient accents, or
  hero-metric templates. This is a reading app.
- **Don't** recreate a **cluttered legacy reader**: no dense toolbar walls or every-feature-visible
  chrome crowding the content.
- **Don't** drift toward the **cream/beige editorial cliché**: the body background is true white
  (`#ffffff`) / dark (`#1a1a1a`), never warm paper. Warmth, if any, comes only from Highlight Gold
  inside the article.
- **Don't** let the social layer look like an **algorithmic feed**: shares and notes stay quiet,
  chronological, and human-scaled — no engagement-bait styling.
- **Don't** add resting `box-shadow` to in-flow cards, rows, or panels (The Flat-By-Default Rule).
- **Don't** introduce a second UI typeface; hierarchy is weight and size in the system sans.
- **Don't** use a colored `border-left` / `border-right` stripe as an accent on rows, cards, or
  alerts — use the Wash Blue tint or a full border.
- **Don't** exceed `1.25rem` for UI headings; there is no hero display type in this app.
- **Don't** use `background-clip: text` gradient text anywhere. Emphasis is weight and size.
