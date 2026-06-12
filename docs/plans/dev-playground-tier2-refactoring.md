# Dev Playground — Tier 2 Refactoring Plan

_Companion to the Tier 1 dev harnesses under `frontend/src/routes/dev/`._

## Background

Tier 1 (shipped) covers the **presentational** components — anything that renders
purely from its props, with no `$lib/stores/*` or `$lib/services/*` import. Those
32 components are exercised live, with no auth and no backend, under:

- `/dev` — the harness catalog (`_harness/registry.ts`)
- `/dev/cards`, `/dev/primitives`, `/dev/common`, `/dev/sources`, `/dev/sidebar`,
  `/dev/feed`

The shared harness library is `frontend/src/routes/dev/_harness/`
(`Showcase.svelte`, `Case.svelte`, `registry.ts`). Every new harness route should
build on it and add a `registry.ts` entry.

This document catalogs the **42 store/service-coupled components** that Tier 1
does _not_ yet cover, bucketed by how hard they are to drop into a harness. The
buckets are ordered easiest → hardest; tackle them roughly in that order.

> **Reconciling the count.** Of the 47 components that import a store or service,
> 5 import only a _service_ and call it lazily (on user action), so they render
> fine standalone — they're the natural next Tier-1 additions and are listed as
> Bucket A. The remaining 42 read app state at render time and need that state
> seeded or injected. 27 (no imports) + 5 (Bucket A) = the 32 presentational
> components Tier 1 targets.

## The core obstacle

Stores are module-level singletons (`export const fooStore = new FooStore()` in
`*.svelte.ts`). A component that does `import { fooStore } from '$lib/stores/foo'`
reaches into global state that, in a dev route, is empty. So the component either
renders blank, throws, or fires a network call through a service.

Two refactoring strategies recur below:

1. **Seed the singleton.** In the harness `+page.svelte`, import the same store and
   populate it before mount (e.g. `subscriptionsStore.items = MOCK`). Cheap, but
   leaks mock state into a shared global and is brittle when a store also kicks off
   fetches in its constructor or on access.
2. **Extract a presentational inner view** (the pattern already used for
   `ArticleCard` → `ArticleCardView`). Split the store-reading shell from a
   props-only view component, harness the view. More work up front, but the view
   becomes permanently harness-able and testable, and the split is good hygiene.

Prefer (2) for components we actively iterate on (cards, rows, the reader); use
(1) for low-churn surfaces where a one-line seed is enough.

A third option worth piloting: a **mock store provider** — a dev-only module that
re-exports each store pre-seeded, swapped in via a Vite alias under
`/dev`. Heavier infra, but it would unlock Buckets C and D without touching
component source. Spike this if seeding-per-route proves too repetitive.

---

## Bucket A — Service-only (quickest Tier-1 wins) — 5 components

Import a single service (`api`, `profiles`, `blueskySearch`) and call it only on
user action, so they render standalone today. To harness cleanly, stub the one
service (a tiny mock module + Vite alias, or accept the no-op/failed fetch in
dev). Good first promotions into a Tier-1 route (e.g. a `/dev/users` or
`/dev/discovery` group).

| Component | Service | Note |
| --- | --- | --- |
| `ProfileHandle` | `profiles` | Fires `getProfile(did)` in an `$effect`; renders the DID until it resolves. Stub `profileService` to render the handle. |
| `UserCard` (root) | `profiles` | Same `$effect` fetch as above; the `common/UserCard` it parallels is already harnessed. |
| `UserSearch` | `blueskySearch` | Search only fires on input; renders the empty input fine. |
| `feed/MentionAutocomplete` | `blueskySearch` | Lazy `@`-triggered lookup; static otherwise. |
| `FeedDiscoveryForm` | `api` | Calls `api` on submit only; the form renders standalone. |

## Bucket B — Single-store, thin slice — 16 components

Import exactly one store and read a small slice of it. Easiest path: seed that one
store in the harness route, or lift the slice to a prop. Several are good
candidates for a tiny inner-view extraction.

| Component | Store | Note |
| --- | --- | --- |
| `AddDropdownMenu` | `sidebar` | Reads sidebar UI flags. |
| `AddSourceInput` | `sidebar` | UI-state only. |
| `CollectionPicker` | `collections` | Render once `collectionsStore` has items. |
| `EditFeedModal` | `subscriptions` | Edits one subscription record. |
| `KeyboardShortcutsModal` | `keyboard` | Reads the shortcut registry; mostly static. |
| `NotificationBell` | `notifications` | Renders an unread badge from the store. |
| `NotificationList` | `notifications` | Seed `notificationsStore.items`. |
| `RefreshProgressBar` | `app` | Reads a global refresh-progress value. |
| `Toast` | `toast` | Seed `toastStore` with a message to show the toast. |
| `common/PageHeader` | `sidebar` | Reads sidebar collapse state for layout. |
| `feed/AppearanceToolbar` | `preferences` | Bound to `preferencesStore`; seed defaults. |
| `feed/LinkblogIntro` | `myLinkblog` | Gated on `myLinkblogStore` state. |
| `feed/TagMenu` | `itemLabels` | Reads the tag/label set. |
| `sidebar/FeedErrorPopover` | `feedStatus` | Reads a feed's error from `feedStatusStore`. |
| `sidebar/FeedItem` | `feedStatus` | Row that reflects per-feed status. |
| `feed/ShareNoteComposer` | `mediaQuery` | Only needs `mediaQueryStore` for responsive layout — trivial to seed. |

## Bucket C — Multi-store views — 13 components

Read several stores together (subscriptions + views + labels + counts, etc.) but
without heavy side effects. Need multiple stores seeded coherently; a mock-store
provider (option 3 above) would pay off most here.

| Component | Stores |
| --- | --- |
| `FilteredViewModal` | `filteredViews`, `subscriptions`, `articles`, `feedView`, `itemLabels` |
| `FollowingPublications` | `followingPublications`, `subscriptions` |
| `LibraryEmptyState` | `auth`, `sync`, `subscriptions` (+ `api`) |
| `LinkblogDiscovery` | `linkblogDiscovery`, `subscriptions` |
| `NavigationDropdown` | `sidebar`, `subscriptions`, `itemLabels`, `unreadCounts`, `filteredViews`, `feedView` |
| `feed/FilterToolbar` | `feedView`, `filteredViews`, `subscriptions`, `itemLabels` |
| `feed/MobileBottomBar` | `sidebar`, `notifications` |
| `feed/MobileFeedSwitcher` | `subscriptions`, `itemLabels`, `unreadCounts`, `filteredViews`, `feedView`, `channelSuggestions`, `savedChannelSuggestions` |
| `feed/MobileFilterSheet` | `feedView`, `subscriptions`, `articles`, `filteredViews`, `itemLabels` |
| `feed/SavedCard` | `feedView`, `subscriptions`, `itemLabels`, `saves` (+ `db`) |
| `feed/SavedListView` | `feedView`, `subscriptions`, `itemLabels`, `saves` |
| `feed/StaticPageChrome` | `notifications`, `mediaQuery` |
| `feed/FeedListView` | `feedView`, `subscriptions`, `itemLabels`, `linkblog`, `preferences` |

## Bucket D — Orchestrators & network-heavy — 13 components

Import many stores **and** services, run fetches, mutations, OAuth, sync, or
IndexedDB access. Don't harness these directly — extract the presentational inner
view (the `ArticleCard` → `ArticleCardView` pattern) and harness that, or stand up
a full mock environment. Highest effort, do last.

| Component | Coupling |
| --- | --- |
| `ArticleCard` | ~14 stores + `api`, `db`, `profiles` — the feed-item orchestrator. Its view (`ArticleCardView`) is already extracted and harnessed in `/dev/cards`; treat as the template. |
| `Sidebar` | ~13 stores + `feedFetcher` — the whole left rail. |
| `feed/FeedPage` | ~20 stores + `api`, `profiles`, `sync-queue` — the main view shell. |
| `feed/FeedPageHeader` | `sidebar`, `sync`, `feedView`. |
| `feed/SavedReader` | 8 stores + `db`, `profiles` — the saved-article reader. |
| `feed/LinkContextMenu` | `saves`, `toast` — fires save mutations. |
| `AddFeedModal` | `subscriptions`, `articles`, `social`, `sidebar` + `feedFetcher`, `api`, `sync`. |
| `AddHandleModal` | 4 stores + `blueskySearch`, `api`, `feedFetcher`, `profiles`, `sync`. |
| `ImportOPMLModal` | `subscriptions`, `articles`, `auth` + `liveDb`, `feedFetcher`. |
| `SaveArticleModal` | `saves` + `api`. |
| `sidebar/FeedAddCompact` | `subscriptions`, `articles`, `auth` + `api`, `feedFetcher`. |
| `sidebar/SidebarAddFeed` | 5 stores + `feedFetcher`, `blueskySearch`, `api`. |
| `sources/SourcesDiscovery` | `standardSubs`, `subscriptions` + `api`. |

---

## Suggested sequencing

1. **Pilot the mock-store provider** on one Bucket-B store (e.g. `notifications`
   for `NotificationBell` + `NotificationList`). If the Vite-alias approach is
   clean, it becomes the standard for B and C.
2. **Promote Bucket A** into a new `/dev/users` (or `/dev/discovery`) route with a
   stubbed service module — five components for little cost.
3. **Work Bucket B** route-by-route, grouped like Tier 1 (a `/dev/notifications`,
   `/dev/modals`, etc.), seeding the single store per case.
4. **Bucket C** once the mock-store provider exists.
5. **Bucket D** last — extract inner views for the orchestrators we iterate on
   (`SavedReader`, `FeedPage`), harness those, and leave the thin shells uncovered.

Keep every new route under `src/routes/dev/**` behind the existing dev-only 404
guard (`dev/+layout.ts`), and add a `registry.ts` entry so it shows on `/dev`.
