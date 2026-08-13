---
name: Skyreader
description: A calm reading app for making sense of everything you read. Reading-first, social without the timeline, portable by foundation.
colors:
  primary: '#0066cc'
  primary-dark: '#0052a3'
  primary-wash: 'rgba(0, 102, 204, 0.1)'
  night-primary: '#4da6ff'
  night-primary-dark: '#3399ff'
  night-wash: 'rgba(77, 166, 255, 0.15)'
  bg: '#ffffff'
  bg-secondary: '#f5f5f5'
  text: '#333333'
  text-secondary: '#666666'
  border: '#e0e0e0'
  night-bg: '#1a1a1a'
  night-bg-secondary: '#2a2a2a'
  night-text: '#e0e0e0'
  night-text-secondary: '#999999'
  night-border: '#404040'
  success: '#4caf50'
  warning: '#ff9800'
  error: '#f44336'
  error-dark: '#d32f2f'
  highlight: '#f5c518'
  highlight-ink: '#9a7700'
  night-highlight-ink: '#e3b94a'
  sky: '#4a9fd4'
  sky-deep: '#1e6fa8'
  sky-light: '#87ceeb'
  sky-wash: '#e8f4fc'
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif"
    fontSize: '1.25rem'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.01em'
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif"
    fontSize: '0.9375rem'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 'normal'
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif"
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif"
    fontSize: '0.875rem'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 'normal'
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif"
    fontSize: '0.8125rem'
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 'normal'
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif"
    fontSize: '0.6875rem'
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: '0.05em'
  article:
    fontFamily: "var(--article-font, Charter, 'Bitstream Charter', 'Iowan Old Style', Georgia, Cambria, serif)"
    fontSize: '1.125rem'
    fontWeight: 400
    lineHeight: 1.8
    letterSpacing: 'normal'
  article-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif"
    fontSize: '1.75rem'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.01em'
rounded:
  xs: '2px'
  sm: '4px'
  md: '6px'
  lg: '8px'
  xl: '12px'
  sheet: '16px'
  pill: '999px'
spacing:
  2xs: '4px'
  xs: '6px'
  sm: '8px'
  md: '12px'
  lg: '16px'
  xl: '24px'
  2xl: '32px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '#ffffff'
    typography: '{typography.label}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  button-primary-hover:
    backgroundColor: '{colors.primary-dark}'
    textColor: '#ffffff'
  button-secondary:
    backgroundColor: '{colors.bg-secondary}'
    textColor: '{colors.text}'
    typography: '{typography.label}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  button-secondary-hover:
    backgroundColor: '{colors.border}'
    textColor: '{colors.text}'
  button-danger:
    backgroundColor: '{colors.error}'
    textColor: '#ffffff'
    typography: '{typography.label}'
    rounded: '{rounded.md}'
    padding: '8px 16px'
  button-danger-hover:
    backgroundColor: '{colors.error-dark}'
    textColor: '#ffffff'
  card:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.text}'
    rounded: '{rounded.lg}'
    padding: '16px'
  input:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.text}'
    typography: '{typography.body}'
    rounded: '{rounded.md}'
    padding: '8px 12px'
    width: '100%'
  nav-item:
    backgroundColor: 'transparent'
    textColor: '{colors.text}'
    typography: '{typography.label}'
    rounded: '{rounded.xl}'
    padding: '8px 12px'
  nav-item-active:
    backgroundColor: '{colors.primary-wash}'
    textColor: '{colors.primary}'
    rounded: '{rounded.xl}'
    padding: '8px 12px'
  chip:
    backgroundColor: '{colors.bg-secondary}'
    textColor: '{colors.text-secondary}'
    typography: '{typography.micro}'
    rounded: '{rounded.pill}'
    padding: '2px 7px'
  chip-active:
    backgroundColor: '{colors.primary-wash}'
    textColor: '{colors.primary}'
  unread-badge:
    backgroundColor: '{colors.primary}'
    textColor: '#ffffff'
    typography: '{typography.micro}'
    rounded: '{rounded.sm}'
    padding: '2px 6px'
  article-row:
    backgroundColor: 'transparent'
    textColor: '{colors.text}'
    typography: '{typography.body}'
    rounded: '{rounded.lg}'
    padding: '0 16px'
  modal:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.text}'
    rounded: '{rounded.lg}'
    padding: '24px'
    width: '100%'
    size: '480px'
  bottom-sheet:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.text}'
    rounded: '{rounded.sheet}'
    padding: '12px 16px 8px'
    width: '100%'
  popover-menu:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.text}'
    typography: '{typography.label}'
    rounded: '{rounded.lg}'
    padding: '10px 14px'
    size: '140px'
  tooltip:
    backgroundColor: '{colors.bg}'
    textColor: '{colors.text-secondary}'
    typography: '{typography.micro}'
    rounded: '{rounded.md}'
    padding: '4px 8px'
---

# Design System: Skyreader

## Overview

**Creative North Star: "The Reading Room"**

Skyreader is a quiet place to read deeply and think clearly, open to the people you trust and closed
to the algorithm. Everything you follow comes into one calm room; the design exists to make reading
it, and making sense of it, feel unhurried and ordered. Chrome is quiet and recedes; the text you
came to read is the one element allowed to raise its voice. Every surface decision is measured
against a single question from PRODUCT.md: does this help or distract from reading? When in doubt,
it goes. (The room is also yours, running on infrastructure you own, but that is the foundation
under the calm rather than something the design needs to shout.)

The system is **flat, restrained, and content-forward**. Depth comes from 1px borders and tonal
background layering, not decoration; shadows appear only when something genuinely floats above the
page. Color is held in reserve: a single confident blue carries interaction and the rest of the
interface is a disciplined neutral ramp, so an article, a highlight, or an unread marker reads
instantly. Density is deliberately tight in the chrome (an 11px to 15px band does most of the work
in lists and toolbars) and deliberately generous in the reading surface, where an 18px serif at
1.8 line-height sits in an 800px band. That contrast between compact chrome and open prose is the
system's signature: the app is efficient everywhere except where you are actually reading.

It works in light and dark, both passing contrast independently, and it honors
`prefers-reduced-motion` on every transition. This system explicitly **rejects** four things,
carried from PRODUCT.md's anti-references: the cards-everywhere, gradient-accent **generic SaaS
dashboard**; the dense-toolbar **cluttered legacy reader**; the warm-paper, serif-everything
**cream/beige editorial cliché**; and the engagement-bait **algorithmic social feed**.

**Key Characteristics:**

- Flat by default; depth only where things overlap.
- One blue. Color is rare and therefore meaningful.
- Neutral, near-monochrome chrome so content is the only color event.
- Compact chrome, open prose: a tight 11px to 15px UI band around an 18px, 1.8-leading reading column.
- Reader-controlled article typography (four families, eleven sizes) is a first-class feature.
- Everything is theme-paired: every neutral and the primary itself have a night value.

## Colors

A near-monochrome neutral system with one disciplined blue for interaction and a small set of
semantic signals. The point of the restraint is that when color appears, it means something.

### Primary

- **Skyreader Blue** (`#0066cc`): The single interaction color. Primary buttons, links, active
  navigation, focus rings, unread badges, and the sidebar's selected state. This is the **only**
  blue in the interface. See The One Blue Rule.
- **Pressed Blue** (`#0052a3`): The hover and active state for primary buttons and pressed controls.
  Only ever a state shift of the primary, never a standalone fill.
- **Wash Blue** (`rgba(0, 102, 204, 0.1)`, shipped as `--color-sidebar-active`): The primary at low
  intensity, for selected sidebar rows, active chips, and highlighted feed rows. Selection reads as
  a tint, not a heavy fill.
- **Lifted Blue** (`#4da6ff`) and **Lifted Pressed** (`#3399ff`): The dark-theme substitutions for
  the primary pair, with **Night Wash** (`rgba(77, 166, 255, 0.15)`) as the matching tint. See The
  Lifted-Primary Rule.

### Secondary

- **Sky Identity** (`#4a9fd4`), with **Sky Deep** (`#1e6fa8`), **Sky Light** (`#87ceeb`), and
  **Sky Wash** (`#e8f4fc`): The "Sky" in Skyreader. Reserved for **brand identity marks only**, as
  the gradient in the app icon (`static/icons/icon-512.svg`) and the OG image. It sets the lighter,
  airier brand note the OS shows around the installed app's icon. It is **not** an in-app UI color;
  inside the app, the primary is Skyreader Blue.

  **Not `theme-color`.** Browser and OS chrome takes the reading surface instead (`#ffffff` light,
  `#1a1a1a` dark, declared per `prefers-color-scheme` in `app.html`; the web manifest carries
  `#ffffff`). Mobile Safari paints its own bottom toolbar with `theme-color`, and that toolbar sits
  directly beneath the app's mobile bottom bar. A brand-blue band under a white bar reads as two
  mismatched surfaces; matching them makes the pair read as one, and the installed app opens into
  the same quiet surface it reads on. Declare `theme-color` only in `app.html`: a copy in a
  `<svelte:head>` renders later and would override both scheme variants with a single value.

### Tertiary

- **Highlight Gold** (`#f5c518`): The reader's text-highlight color, applied as a translucent `mark`
  background via `color-mix` (25% at rest, 40% on hover, 32% behind a note marker, 70% as the rule
  on a quoted highlight). The one warm accent in the system, and only ever in reading surfaces.
- **Highlight Ink** (`#9a7700`, night `#e3b94a`): The darker and lighter shades of the same hue used
  for the inline note-marker glyph, so a note reads as part of its highlight rather than as new
  chrome.

### Neutral

- **Surface** (`#ffffff` light, `#1a1a1a` night): The base reading background. The article sits here.
- **Sunken** (`#f5f5f5` light, `#2a2a2a` night): Secondary surface for sidebars, secondary buttons,
  inline code, and recessed panels. Tonal layering, not shadow, separates it from Surface.
- **Ink** (`#333333` light, `#e0e0e0` night): Primary body and heading text.
- **Muted Ink** (`#666666` light, `#999999` night): Metadata, timestamps, secondary labels, read
  article titles. Held to the 4.5:1 bar for body-sized text, never drifting into decorative gray.
- **Divider** (`#e0e0e0` light, `#404040` night): 1px borders, dividers, input strokes, card edges,
  the bottom-sheet grab handle. The primary depth mechanism in a flat system.

### Semantic

- **Success** (`#4caf50`): Sync-complete, confirmation toasts, online status.
- **Warning** (`#ff9800`): Stale-feed and degraded-state signals.
- **Error** (`#f44336`) and **Error Pressed** (`#d32f2f`): Failed sync, destructive actions,
  validation errors, and the danger button's hover.

### Named Rules

**The One Blue Rule.** There is exactly one interaction blue: `#0066cc` (`--color-primary`). The
values `#2563eb` (21 uses), `#0085ff` (19 uses), and `#3b82f6` (4 uses) currently present across
twelve components are **drift, not palette**, and are scheduled for consolidation into
`--color-primary`. The `#0085ff` cluster is concentrated in `AddHandleModal`, `AddFeedModal`, and
`SidebarAddFeed`; `#3b82f6` survives as a stale fallback in `Sidebar.svelte`. Never introduce a new
blue. If a surface needs a blue, it is this blue or a documented tint of it.

**The Lifted-Primary Rule.** The primary is the one non-neutral token that changes value by theme.
`#0066cc` on the night surface `#1a1a1a` measures roughly 3.1:1, below the AA body-text bar, so dark
mode lifts it to `#4da6ff` (roughly 6.8:1) and its pressed state to `#3399ff`, with the selection
wash correspondingly raised to 15% alpha. Any new primary-derived value must ship a night pair;
never hard-code `#0066cc` where the token would have been theme-swapped.

**The Reserved Color Rule.** Outside of the one blue and the semantic trio, the interface is
neutral. Color is an event: an unread dot, a highlight, a sync state. If a screen has more than one
non-neutral hue competing for attention (excluding semantic state), something is wrong.

**The Phantom Token Rule.** Every color must be defined in `:root` before it is referenced.
`--color-bg-hover` (51 uses), `--color-accent` (21), `--color-surface-2`, `--color-text-tertiary`,
`--color-danger`, `--color-warning-bg`/`-text`/`-border`, `--color-error-bg`, `--color-shadow`, and
`--radius-md` are referenced but **never declared anywhere**, so every use silently resolves to its
inline fallback. That is worse than a hard-coded value, because the fallbacks are light-theme
constants: `var(--color-bg-hover, rgba(0, 0, 0, 0.05))` renders an invisible hover on a `#1a1a1a`
night surface. Either declare the token in both themes or inline the literal. Never add a new
`var(--color-X, fallback)` for an undeclared `X`.

## Typography

**UI Font:** The native system sans stack (`--font-sans-serif`): `-apple-system,
BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif`. Skyreader uses **one UI
typeface**, expressed through weight and size rather than multiple families. It loads instantly,
matches each OS, and disappears, which is exactly what reader-first chrome wants.

**Article Font:** Reader-selectable via `--article-font` and the `data-article-font` attribute
across four choices: **serif** (the default: `Charter, 'Bitstream Charter', 'Iowan Old Style',
Georgia, Cambria, serif`, preferring the screen-grade serifs that ship on Apple platforms before
falling back to Georgia), **sans** (the system stack), **mono** (`ui-monospace, SFMono-Regular,
'SF Mono', Menlo, Consolas, monospace`), and **Literata** (`--font-literata`), the one opt-in web
font: self-hosted variable weight 200 to 900 with an optical-size axis, `font-display: swap`, and
split latin / latin-ext unicode ranges so it only downloads when a reader actually selects it. Size
is reader-selectable and applied as an inline px value on the document root by AppShell; the CSS
default (`1.125rem`, 18px) exists only to keep the pre-hydration paint from flashing.

**Character:** Quiet and native in the chrome; reader-owned in the article. The UI never imposes a
typographic personality that competes with the text the reader chose to format. `font-optical-sizing:
auto` is set on the root so a variable article face picks its own optical master by size.

### Scale

A fixed-rem ladder of eleven steps, deliberately dense in the middle. The 11px to 15px band is
tightly stepped (11, 12, 13, 14, 15) because the app serves readers tracking many feeds and needs
several distinguishable weights of secondary information in one row. The steps above 20px exist for
exactly three places: the reader's article title, the empty-state hero, and roomy public pages.

`--text-3xs` 10px · `--text-2xs` 11px · `--text-xs` 12px · `--text-sm` 13px · `--text-md` 14px ·
`--text-lg` 15px · `--text-base` 16px · `--text-xl` 18px · `--text-2xl` 20px · `--text-3xl` 24px ·
`--text-4xl` 28px.

Weights are `--weight-regular` 400, `--weight-medium` 500, `--weight-semibold` 600, `--weight-bold` 700. Line heights are `--leading-none` 1, `--leading-tight` 1.3, `--leading-snug` 1.4,
`--leading-normal` 1.5, `--leading-relaxed` 1.6. Tracking is `--tracking-tight` -0.01em,
`--tracking-wide` 0.03em, `--tracking-wider` 0.05em.

### Hierarchy

- **Headline** (600, `1.25rem`, line-height 1.3, tracking -0.01em): Page titles, modal headers, and
  major section titles. The largest type the chrome is allowed.
- **Title** (600, `0.9375rem`, line-height 1.4): List titles, source names, emphasized UI text.
- **Body** (400, `1rem`, line-height 1.5): Default UI text, controls, and feed-row article titles.
  Note the feed title is `regular`, not semibold: in a list of forty rows, weight is scanning noise,
  so hierarchy there comes from color and position instead.
- **Meta** (400, `0.8125rem`, line-height 1.4): The workhorse secondary line. Timestamps, feed
  names, counts. Usually in Muted Ink.
- **Label** (500, `0.875rem`, line-height 1.4): Buttons, form labels, menu items, secondary actions.
- **Micro** (500, `0.6875rem`, tracking 0.05em): Eyebrow labels, badge counts, chip text. The one
  place letter-spacing is opened up.
- **Article** (400, reader-set size defaulting to `1.125rem`, line-height 1.8): The reading surface.
  Reader-controlled family and size, in an 800px column.
- **Article Title** (600, `1.75rem`, line-height 1.3, tracking -0.01em): The reader's own headline,
  and the single largest type in the product.

### Named Rules

**The One Voice Rule.** The chrome uses a single typeface family. Hierarchy comes from size, weight
(400 / 500 / 600), and color, never from introducing a second UI font. The only typographic variety
the user should see is the one _they_ chose for the article body.

**The No-Shout Rule.** Chrome headings top out at `--text-2xl` (1.25rem). There is no hero display
type in the app shell. `--text-3xl` (24px) and `--text-4xl` (28px) exist and are legitimate, but
only on three surfaces: the reader's article title, empty-state and welcome heroes, and roomy public
pages. If a step above 20px appears in a sidebar, toolbar, list row, or modal, it is a mistake.

**The Reader-Owns-The-Article Rule.** Never hard-code a family or size on article body text. Read
`var(--article-font)` and `var(--article-font-size)`, and size anything that sits inside the prose
(footnote markers, note glyphs, pull quotes) in `em` so it tracks the reader's choice rather than
the app's scale.

## Layout

**The shell.** A 320px sidebar (`--sidebar-width`, drag-resizable, with `body.sidebar-resizing`
suppressing transitions during the drag) holds sources and channels; the content column fills the
rest. Reading surfaces open as opaque full-screen overlays _above_ the sidebar rather than beside
it, which is why the reader's chrome frames the viewport instead of tracking the column.

**One structural breakpoint.** `1000px` is the line that matters: above it the sidebar is
persistent, below it becomes an overlay drawer with `body.sidebar-open-mobile` locking page scroll,
and a `--bottom-bar-height` (3.5rem) bottom bar appears. Safe-area insets (`--safe-area-bottom`,
`--safe-area-top`) are respected on both. `640px` is the secondary phone-density step for tightening
padding and dropping optional furniture; `1100px` and `900px` trim wide reader chrome. Do not add a
new structural breakpoint without a reason the existing three cannot carry.

**The 800px band.** The feed body (`.feed-page-body`) and the reader (`.reader-container`) share the
same `max-width: 800px; margin: 0 auto; padding: 0 1rem` column, so an article occupies the exact
horizontal space its list row did and expanding one does not shift the page. Paged reading mode is
the one exception: it widens to a 1200px two-column spread.

**Measure for chrome prose.** Explanatory copy caps between 42ch and 62ch (empty states 42ch, intro
and comment copy 60ch, the welcome page 62ch). Article prose uses the 800px band rather than a `ch`
cap, since the reader's chosen size determines the effective measure.

**Spacing rhythm.** 8px is the workhorse (roughly twice as common as any other step), with 12px and
4px next, and 6px for tight icon gaps. 16px is the standard card and section inset; 24px and 32px
handle page-level separation. Modals use a 24px header and body inset with a 16px/24px footer.

**Container queries over viewport queries for components.** The article card declares
`container: card / inline-size` and responds to the column width it is handed, not the viewport, so
it renders correctly in the feed, in a narrow lane, and in the `/dev/cards` width-slider harness
alike. Prefer this for any component that appears at more than one width.

**The component harness.** `/dev/*` is a dev-only tree (404s in production) of isolated component
canvases, cataloged in `src/routes/dev/_harness/registry.ts`. Add an entry when adding a component
worth seeing in every state.

## Elevation & Depth

**Flat by default; shadow only on overlap.** Content surfaces (the feed, the article, the sidebar,
cards, rows, the sticky reader header) are flat. They separate through 1px Divider borders and tonal
layering (Surface against Sunken), never through resting shadows or blur. Shadow is reserved for
elements that genuinely float above the page: modals, sheets, dropdowns, popovers, tooltips, and the
pull-to-refresh affordance.

### Shadow Vocabulary

- **Raised** (`0 2px 8px rgba(0,0,0,0.1)`, night `0.4`): Small floating elements. Context menus,
  compact popovers.
- **Floating** (`0 4px 12px rgba(0,0,0,0.15)`, night `0.4`): Tooltips (`.app-tooltip`) and popover
  menus.
- **Lifted** (`0 4px 16px rgba(0,0,0,0.15)`, night `0.4`): The workhorse overlay shadow. Dropdowns,
  floating toolbars, action bars.
- **Dialog** (`0 4px 20px rgba(0,0,0,0.15)`, night `0.4`): The shared `Modal` above a
  `rgba(0,0,0,0.5)` backdrop.
- **Sheet** (`0 -4px 24px rgba(0,0,0,0.15)`, night `0.4`): The mobile `BottomSheet`, cast upward,
  above a `rgba(0,0,0,0.4)` backdrop (night `0.6`).
- **Focus Ring** (`0 0 0 2px rgba(0,102,204,0.1)`): The primary-tinted focus indicator. A glow
  rather than a shadow, but it lives in the same vocabulary.

### Named Rules

**The Flat-By-Default Rule.** A surface at rest casts no shadow. If you are adding a `box-shadow` to
a card, list row, panel, or sticky header that is part of the page flow, stop and use a border or a
tonal background instead. Shadow signals that an element has left the page plane.

**The Night-Alpha Rule.** Diffuse shadow reads weakly on dark surfaces, so every shadow ships a
night value at roughly triple the alpha: 0.1 becomes 0.3, 0.15 becomes 0.4, 0.25 becomes 0.5. A
shadow declared without a `prefers-color-scheme: dark` counterpart is incomplete.

**The One Ring Rule.** Focus indication currently ships in five shapes (`2px` at 0.1, 0.15, and 0.18
alpha; `3px` at 0.35 and against `--color-sidebar-active`; and a solid `2px var(--color-primary)`).
That inconsistency is drift. Standardize on the primary-tinted 2px ring, and never remove a focus
affordance without replacing it.

## Shapes

**A four-step radius ladder, assigned by role rather than by size.**

- **2px** (`xs`): The bottom-sheet grab handle and other hairline affordances.
- **4px** (`sm`): Micro surfaces. Unread count badges, inline code spans, small tags.
- **6px** (`md`): Controls. Buttons, inputs, tooltips, icon-button hit targets.
- **8px** (`lg`): Containers. Cards, modals, popover menus, and the feed row's hover tint.
- **12px** (`xl`): Sidebar navigation rows. Deliberately _larger_ than a card, which is the one
  intentional inversion in the ladder: a softer pill makes selection read as a resting state inside
  the rail rather than as a box drawn around a link.
- **16px** (`sheet`): The bottom sheet's top corners only, where the radius reads as the sheet
  lifting off the screen edge.
- **999px** (`pill`): Chips, tags, source labels, counts, segmented controls.
- **50%**: Avatars, the read/unread dot, circular icon toggles.

**Borders.** A 1px solid Divider is the universal separator and the primary depth mechanism. The one
thicker stroke is the 1.5px ring on the read/unread toggle, which needs to read as a target at 14px.

**Stripes.** Colored side-borders are not an accent device: use the Wash Blue tint or a full border
instead. The single sanctioned exception is the 3px gold rule on a quoted highlight in the highlights
page, where the stripe is a quotation convention rather than a status accent.

**Motion.** Transitions are short and property-scoped. `0.15s` is the default for hover and
background changes, `0.2s` for buttons and width changes, `0.25s` for larger reveals, `0.1s` for
press feedback. Easing is `ease` by default, with `cubic-bezier(0.22, 1, 0.36, 1)` for entrances
that should settle rather than bounce. Never animate `all`. Every animated rule needs a
`@media (prefers-reduced-motion: reduce)` counterpart that drops to a crossfade or nothing; 24 files
already carry one.

## Components

Components are **refined and restrained**: modest radii, quiet state changes, no heavy fills or
bouncy motion. They are reliable and unobtrusive, and the UI never competes with content.

### Buttons

- **Shape:** 6px radius, `8px 16px` padding, weight 500, inline-flex with an 8px gap for optional
  icons. No borders on primary or danger.
- **Primary:** Skyreader Blue fill, white text. One high-emphasis action per view.
- **Secondary:** Sunken fill, Ink text, 1px Divider border. Hover deepens to the Divider color.
- **Danger:** Error fill, white text, hovering to Error Pressed. Destructive actions only.
- **Hover / Focus:** A 0.2s `background-color` transition only. No transform, no scale, no bounce.
  Focus shows the primary-tinted ring.

### Chips

- **Style:** Pill (999px), Sunken background, Muted Ink text, Micro type at `2px 7px`. No border.
- **State:** Active chips take the Wash Blue background and primary text. Counts and source labels
  use the same shape at Micro size.
- **Unread badge:** The one chip that takes a solid primary fill with white text, at 4px radius and
  `--text-3xs`, so a count reads as a signal rather than a label.

### Cards / Containers

- **Corner Style:** 8px radius. **Background:** Surface. **Border:** 1px solid Divider.
  **Internal Padding:** 16px. **Shadow:** none at rest.
- Cards are used sparingly, for genuinely grouped content. Nested cards are forbidden. The feed is a
  list of rows, not a grid of boxes.

### Inputs / Fields

- **Style:** Full-width, 1px Divider stroke, Surface background, 6px radius, `8px 12px` padding,
  inheriting the UI font and size.
- **Focus:** The default outline is removed in favor of a border shift to the primary. Where a ring
  is also shown, it is the primary-tinted 2px ring.
- **Error:** Error-colored helper text at `--text-md` with a 4px top margin.

### Navigation (Sidebar)

- **Style:** A 320px resizable Sunken rail of sources and channels in expandable sections. Rows are
  `8px 12px` at 12px radius, Label type.
- **States:** Default rows in Ink; hover takes a faint neutral tint; the **active** row uses Wash
  Blue with primary text. Selection by tint, never by a heavy fill or a colored side stripe.
- **Mobile:** Below 1000px the rail becomes an overlay drawer over a `rgba(0,0,0,0.5)` scrim, with
  `body.sidebar-open-mobile` locking scroll behind it and a 3.5rem bottom bar respecting safe-area
  insets.

### Overlays

- **Modal** (`common/Modal.svelte`): Portaled to `<body>` so it escapes ancestor stacking contexts.
  Surface background, 8px radius, 480px default max-width, `80vh` max-height, Dialog shadow, over a
  `rgba(0,0,0,0.5)` backdrop. Header and body inset 24px, footer `16px 24px` with a 12px gap, both
  divided by 1px Divider rules. Header title is Headline; the close control is a bare glyph in Muted
  Ink.
- **BottomSheet** (`common/BottomSheet.svelte`): The mobile counterpart. Bottom-anchored, 16px top
  corners, Sheet shadow, a 36x4px Divider grab handle, `env(safe-area-inset-bottom)` padding, and a
  `translateY(100%)` to `0` entrance.
- **PopoverMenu**: Surface background, 1px Divider border, 8px radius, Floating shadow, 140px
  minimum width. Items are `10px 14px` at Label size, hovering to Sunken; destructive items hover to
  a 10% Error tint.
- **Tooltip** (`.app-tooltip`, body-portaled): Surface background, 1px Divider border, 6px radius,
  Floating shadow, `4px 8px` padding, Micro size in Muted Ink, fading in over 0.12s.

### Feed Row (Signature Surface)

The densest and most-repeated element in the product, and the reason the chrome scale is tight.

- **No border, no card.** Rows are borderless, transparent, and separated only by rhythm. Padding is
  `0 16px`; the row is its own inline-size container.
- **Hover** paints a faint neutral tint at 8px radius. Nothing else moves.
- **Read state** is carried three ways at once, never by color alone: the whole row drops to 0.6
  opacity (0.8 on hover), the title shifts from Ink to Muted Ink, and the read toggle's ring fills.
- **Title** is Body weight 400, not semibold, truncated to one line. In a list of forty rows, bolding
  every title is noise rather than hierarchy.
- **Highlighted** (keyboard-selected) rows take a faint blue tint at 8px radius.

### Reading View (Signature Surface)

The most precious surface in the app.

- Opens as an opaque full-screen overlay above the sidebar, centering an 800px column in the whole
  viewport. The sticky header is a flat, full-bleed bar with no blur and no shadow; the rule at its
  bottom is the only edge it needs.
- Body renders with `--article-font` and `--article-font-size` at 1.8 line-height. Paged mode
  switches to a 1200px two-column spread.
- Text highlights use translucent Highlight Gold `mark` backgrounds (25% at rest, 40% on hover),
  with an inline note glyph in Highlight Ink sized in `em`. This is the only place warm color
  appears, and the only color besides links inside the prose.
- Footnotes render text-first: a superscript reference and a hairline-ruled list at the end, muted
  off `currentColor` with `color-mix` rather than off app tokens, so they stay legible on a curated
  edition's own themed background. No boxes, no backgrounds.

## Do's and Don'ts

### Do:

- **Do** use exactly one interaction blue, `#0066cc` (`--color-primary`). Consolidate any `#2563eb`,
  `#3b82f6`, or `#0085ff` you encounter into the token.
- **Do** ship a night value for every primary-derived color and every shadow. The primary itself
  lifts to `#4da6ff` in dark mode; shadows roughly triple their alpha.
- **Do** declare a CSS custom property in `:root` before referencing it. A `var(--x, fallback)` for
  an undeclared `--x` is a light-theme constant wearing a token's clothes.
- **Do** keep content surfaces flat and separate them with 1px Divider borders and Surface-against-Sunken
  tonal layering.
- **Do** reserve shadows for elements that float above the page: modals, sheets, dropdowns, popovers,
  tooltips.
- **Do** hold muted text (`#666666`, night `#999999`) and placeholders to 4.5:1; move toward Ink
  before reaching for a lighter gray.
- **Do** read `var(--article-font)` and `var(--article-font-size)` on every reading surface, and size
  anything inside the prose in `em`.
- **Do** keep the 800px reading band shared between the feed body and the reader, so expanding an
  article does not shift the page.
- **Do** reach for a container query when a component appears at more than one width, and add it to
  the `/dev` harness registry.
- **Do** pair every color signal (unread, sync state, social cue) with opacity, shape, weight, or
  text. Color is never the sole carrier of meaning.
- **Do** provide a `prefers-reduced-motion` fallback for every transition.

### Don't:

- **Don't** build a **generic SaaS dashboard**: no cards-everywhere grids, gradient accents, or
  hero-metric templates. This is a reading app.
- **Don't** recreate a **cluttered legacy reader**: no dense toolbar walls or every-feature-visible
  chrome crowding the content.
- **Don't** drift toward the **cream/beige editorial cliché**: the body background is true white
  (`#ffffff`) or `#1a1a1a`, never warm paper. Warmth comes only from Highlight Gold inside the
  article.
- **Don't** let the social layer look like an **algorithmic feed**: shares and notes stay quiet,
  chronological, and human-scaled.
- **Don't** add a resting `box-shadow`, backdrop blur, or border to an in-flow card, row, or sticky
  header (The Flat-By-Default Rule).
- **Don't** introduce a second UI typeface. Hierarchy is size, weight, and color in the system sans.
- **Don't** use a type step above `--text-2xl` (1.25rem) anywhere in the app shell. 24px and 28px
  belong to the reader's article title, empty-state heroes, and public pages only.
- **Don't** bold feed-row titles. Weight in a long list is noise, not hierarchy.
- **Don't** use a colored `border-left` or `border-right` stripe as an accent on rows, cards, or
  alerts. The 3px gold rule on a quoted highlight is the one exception, and it is a quotation mark,
  not a status.
- **Don't** add a fourth structural breakpoint. 1000px is the shell line, 640px the density step.
- **Don't** animate `all`, and don't add transform, scale, or bounce to a button's hover.
- **Don't** use `background-clip: text` gradient text anywhere. Emphasis is weight and size.
