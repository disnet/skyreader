# From Your Follows: the links people you follow are sharing

> Nuzzel for the Atmosphere. Skyreader reads your Bluesky **Following** timeline, pulls out the
> links, groups them by article, and shows you what the people you follow are sharing, ranked by
> how many of them shared it. Open one and it reads in the calm reader, with their posts sitting in
> the Discussion panel.
>
> Why this, why now: it is the one social-reading feature that works **before your friends are on
> Skyreader**. Rooms, linkblogs and Discussion all need density; this only needs a Bluesky account.
> It gives a new user something worth reading in the first minute, and it gives the landing page a
> screenshot no RSS reader or read-later app can produce.

## Hypothesis

**The good links from your timeline, without the timeline, is a reason to open Skyreader daily.**

The spike succeeds if people who grant the scope come back to it: weekly opens of the surface,
articles opened from it, and saves / linkblog shares that originate from it. It fails if it gets a
look on day one and nothing after, in which case the timeline was doing the job fine.

## The feature in one paragraph

A signed-in user grants one extra OAuth scope (`rpc:app.bsky.feed.getTimeline`). The backend pages
their Following timeline through their PDS (service-proxied to the Bluesky appview), keeps only
posts, quotes and reposts that carry an external link, and writes one row per (user, url, sharer)
into D1. A new `/following` surface (and a Home lane) reads the aggregate: one card per article,
"Maya, Ben and 2 others shared this", ranked by distinct sharers within a window. Opening a card
extracts the article on demand (the rooms path) and the reader's Discussion panel leads with what
your follows actually said about it. Refresh happens on read, gated, with no cron.

## Decisions

### Source: the authenticated Following timeline, not a scan and not the firehose

Three ways to learn what your follows posted:

| Option                                                                         | Cost                                                                            | Verdict                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **`getTimeline` via the user's PDS**                                           | 1 call per 100 posts; steady state 1–3 calls per refresh                        | **Chosen**                                                         |
| Client-side `getAuthorFeed` scan per follow (the `followingRooms` pattern)     | 1 call **per follow** per refresh; 3,000 follows = 3,000 calls                  | Rejected: too slow, stale, heavy on phones                         |
| Jetstream `app.bsky.feed.post` with `wantedDids` = union of everyone's follows | Union blows past the 10k `wantedDids` cap fast; post volume dwarfs the 8s drain | Rejected for v1; revisit only if this becomes a network-wide index |

`getTimeline` also gets several things right for free:

- **Reposts count as shares.** They arrive as `reason: reasonRepost` with the reposter's profile.
- **Mutes and blocks are already applied** by the appview, so the surface respects the user's own
  moderation without Skyreader reimplementing it.
- **Link cards are hydrated.** `embed.external` comes with `uri`, `title`, `description`, `thumb`,
  so a card renders without fetching the page.

The cost is one scope grant and a re-auth, which the app already handles well (see below).

### Scope: opt-in, via the existing scope-upgrade flow

Add `FOLLOWS_LINKS_SCOPES = ['rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app%23bsky_appview']`
to `backend/src/config/scopes.ts`, following the `READING_ROOM_SCOPES` pattern: it joins
`ALL_POSSIBLE_SCOPES` (so new logins get it) but **not** `GRANULAR_SCOPES` (so existing sessions
aren't forced through a re-auth). The route answers `scope_upgrade_required` when the session lacks
it, and the surface's empty state is the prompt: one line explaining what it does, one button.

The grant is the consent. There is no separate settings toggle in v1. Revoking is a sign-out and a
future toggle (v2) that stops refreshing and purges rows.

### Storage: per-user rows in D1, short retention

```sql
-- 0082_follow_link_shares.sql
CREATE TABLE follow_link_shares (
  user_did        TEXT NOT NULL,
  post_uri        TEXT NOT NULL,   -- the post (or reposted post) that carried the link
  sharer_did      TEXT NOT NULL,   -- author, or the reposter for a repost
  kind            TEXT NOT NULL,   -- 'post' | 'quote' | 'repost'
  url             TEXT NOT NULL,
  url_normalized  TEXT NOT NULL,   -- normalizeArticleUrl()
  post_text       TEXT,            -- the sharer's comment, truncated; null for bare reposts
  card_title      TEXT,
  card_description TEXT,
  card_thumb      TEXT,
  sharer_handle   TEXT,
  sharer_name     TEXT,
  sharer_avatar   TEXT,
  shared_at       INTEGER NOT NULL, -- indexedAt of the post, or of the repost
  PRIMARY KEY (user_did, post_uri, sharer_did)
);
CREATE INDEX idx_fls_user_time ON follow_link_shares (user_did, shared_at);
CREATE INDEX idx_fls_user_url  ON follow_link_shares (user_did, url_normalized);

CREATE TABLE follow_link_sync (
  user_did        TEXT PRIMARY KEY,
  newest_seen_at  INTEGER,          -- high-water mark: stop paging once we pass it
  last_poll_at    INTEGER,          -- gate + lock, same trick as room_snapshots
  complete        INTEGER NOT NULL DEFAULT 0, -- first backfill finished
  last_error      TEXT
);

CREATE TABLE follow_link_state (
  user_did        TEXT NOT NULL,
  url_normalized  TEXT NOT NULL,
  opened_at       INTEGER,
  dismissed_at    INTEGER,
  PRIMARY KEY (user_did, url_normalized)
);
```

- **Sharer profile is denormalized onto the row.** The timeline already hydrates it; a separate
  profile cache would be a second thing to keep fresh for no gain.
- **Retention: 7 days.** The hourly cron (`minute === 0` branch in `backend/src/index.ts`) deletes
  `follow_link_shares` older than 7 days and `follow_link_state` older than 30. This is a
  "what's being shared now" surface, not an archive; anything worth keeping gets saved.
- **Opened / dismissed state is server-side** (D1), because read state is server-side everywhere
  else in the app and the surface should agree across devices.
- **Account deletion** must purge all three tables (add them next to the other per-user deletes in
  `backend/src/index.ts`).

### Ingest: what counts as a shared link

For each timeline item from a followed account:

1. **Take:** top-level posts and quote posts with `embed.external`, or with a link facet when
   there is no card; reposts of any of those (sharer = reposter, `kind = 'repost'`).
2. **Skip:** replies (v1 — they're conversation, not recommendation), the user's own posts,
   links to `bsky.app` / `*.bsky.social` / Skyreader's own hosts, and media-only posts.
3. **One link per post.** Prefer `embed.external.uri`, else the first link facet.
4. **Normalize** with `normalizeArticleUrl` (`backend/src/utils/url-normalize.ts`), and drop the
   row if it returns null.
5. **Keep the comment.** `post_text` is the sharer's own words (truncated, ~300 chars), because
   _why_ someone shared something is most of the value.

### Refresh: on read, gated, incremental

Same shape as `pollRoom` (`backend/src/services/backing/room-sync.ts`), which has worked without a
cron:

- `GET /api/v2/following-links` serves from D1 immediately, then, if `last_poll_at` is older than
  **10 minutes**, claims the gate and runs a refresh under `ctx.waitUntil`.
- **Incremental:** page `getTimeline` (limit 100) newest-first until an item is older than
  `newest_seen_at`, or the 10-page cap. Steady state is 1–3 pages. The high-water mark only
  advances when the walk had no errors, so a failed page is re-walked next time, not skipped.
- **First backfill:** walks back to the 7-day retention window, capped at 20 pages (~2,000 posts,
  ~10s). The response carries `complete: false` until it finishes, and the client shows a quiet
  "gathering links from your timeline" state and re-polls, like `followingRooms`' `scanning` flag.
- **Share cap:** at most 600 upserts per refresh (one statement each, against the 1,000
  queries-plus-subrequests invocation budget).
- **Users who never open the surface cost nothing.** No cron, no per-user background work.

Heavy-follow accounts can produce more than 2,000 posts in a day. That's fine: the cap bounds cost,
and the last day or so is exactly the product. Light-follow accounts get the whole week.

### Serving: the aggregate

`GET /api/v2/following-links?window=24h|3d|7d` returns one entry per `url_normalized`:

```ts
{
  url, urlNormalized,
  title, description, thumb, siteName,       // from the freshest card
  sharers: [{ did, handle, name, avatar, kind, postUri, text, sharedAt }],
  sharerCount,                               // distinct sharer_did
  firstSharedAt, lastSharedAt,
  opened: boolean,
}
```

Ranked by `sharerCount` desc, then `lastSharedAt` desc. Dismissed items are excluded. Default
window 24h. No infinite scroll: the list ends, which is part of the calm.

### Frontend

- **Route `/following`** (account-only: add to `ACCOUNT_ROUTES` in `routes/+layout.svelte`).
  Sidebar link next to Rooms / Discover inside the `{#if !auth.isGuest}` block in
  `Sidebar.svelte`. Nav label: **From your follows**.
- **Card**: title, site, thumb, then an avatar stack (reuse the rooms avatar-stack markup from
  `RoomPage.svelte`) and one line: "Maya, Ben and 2 others shared this". Expanding shows each
  sharer's comment. Opened items dim, the same way read items do in the river.
- **Home lane**: "Shared by people you follow", top 6 by sharer count, via `HomeLane.svelte` /
  `LaneCardVM`, guarded by `auth.isGuest` and hidden until the scope is granted (the empty state
  lives on `/following`, not on Home).
- **Opening**: generalize `extractRoomArticle` (`lib/utils/roomArticle.ts`) to take
  `{url, title, image}` and open a synthetic `saved` item through `reader.openReader`. No new
  `FeedDisplayItem` type; "shared by" metadata is looked up by URL on the side, the way HomePage's
  `openRoomRef` finds the room behind an open article. Extraction failure opens the URL in a new
  tab, as rooms do. Opening fires a background `POST /api/v2/following-links/opened`.
- **Discussion panel**: when the open article has follow shares, `ReaderDiscussion` shows a
  **People you follow** group first, built from the rows we already hold (post URIs + text), above
  the network-wide Constellation lanes. This is the payoff: open an article and see what your
  people said about it.
- **Actions per card**: open, save, share to linkblog, dismiss. Save and share reuse the existing
  flows unchanged.

### Tiers

Available on free. It's the acquisition feature, and its cost is bounded per active user. Revisit
only if the refresh budget shows up in the numbers.

## Phases

### Phase 0: prove the call — DONE (2026-09-23)

**Result: the chosen approach works.** Verified locally against a bsky.network-hosted account with
the dev-only probe `GET /api/v2/following-links/probe?pages=N` (`backend/src/routes/follow-links.ts`,
404s when `FRONTEND_URL` isn't loopback).

- **Scope.** Bluesky's auth server accepts
  `rpc:app.bsky.feed.getTimeline?aud=did:web:api.bsky.app%23bsky_appview` on a fresh login and
  grants it back **byte-identical**, so `hasRequiredScopes`' exact-string match works unchanged.
- **Proxying.** `PDSClient` now takes an `atproto-proxy` option (`BSKY_APPVIEW_PROXY`) and has
  `getTimeline(cursor, limit)`. Three 100-item pages came back OK in **1.4s total (~470ms/page)**,
  so the 20-page first backfill is ~9–10s: fine under `waitUntil`, too slow to do inline. Keep the
  `complete: false` + re-poll design.
- **Shapes.** Of 300 items: 48 reposts (`reasonRepost`, reposter in `reason.by`, repost time in
  `reason.indexedAt`), 115 replies, 45 `external#view`, 6 `recordWithMedia#view`, 11
  `record#view`. 44 link shares extracted (31 reposts, 10 posts, 3 quotes) over 40 distinct URLs.
  Mutes are already applied by the appview (`viewer.muted` on every author).
- **Extractor change from the samples.** Quoting someone else's link post now counts as sharing
  that link (sharer = quoter, text = their comment), via the quoted `viewRecord.embeds`. Order: own
  card, own link facet, quoted card.

**Findings that change later phases:**

- **Timeline time isn't recency.** 300 items on a light-follow account spanned three months
  (reposts of old posts, sparse follows). Paging must stop on `sharedAt` older than the window, not
  on a page count alone, and the window filter belongs on `shared_at`.
- **Facet-only links have no card** (no title/description/thumb): 4 of the top 25 here. Phase 1
  needs a title fallback: the freshest card from any sharer of that URL first, then a lazy unfurl
  through the feed proxy for cards still missing one, and the bare host as the last resort.
- **Display the normalized URL, open the original.** Leaflet share links carry long `utm_*` tails;
  grouping already strips them, the card should too.
- **Ranking needs a real account to judge.** The test account follows few people, so nearly every
  URL had one sharer. Re-run the probe on a heavy-follow account before tuning the ranking or the
  window defaults.

**Still unverified:** a self-hosted (non-bsky.network) PDS proxying the same call.

### Phase 1: backend — DONE (2026-09-23)

- Migration `0082_follow_link_shares.sql`: `follow_link_shares`, `follow_link_sync`,
  `follow_link_state`, all `ON DELETE CASCADE` from `users` (there is no account-deletion path
  today; the cascade covers it when there is).
- `backend/src/services/follow-links-store.ts`: `refreshFollowLinks` (claim, walk, upsert,
  high-water mark), `groupFollowLinks` / `readFollowLinks` (serve), `setFollowLinkState`,
  `purgeFollowLinks` (hourly cron).
- Routes in `backend/src/routes/follow-links.ts`: `GET /api/v2/following-links?window=24h|3d|7d`
  (403 `scope_upgrade_required` without the scope) and `POST /api/v2/following-links/state`
  `{ url, action: 'opened' | 'dismissed' | 'restored' }`. Both `STANDARD_LIMIT`.
- **Title fallback, part one:** a link's card is the freshest share that has one, so a bare-facet
  share borrows another follow's card; `site` (host) is the last resort. The lazy unfurl through
  the feed proxy for links no sharer carded is **not built**; add it if bare-host cards read badly.
- Tests: `backend/test/follow-links.spec.ts` (extraction), `backend/test/follow-links-store.spec.ts`
  (walk + high-water mark, failed page, gate + CAS, repost sharers, ranking, card borrowing,
  state, purge, routes).

### Phase 2: the surface — DONE (2026-09-23)

- **Permission ask in the page.** `GET /api/v2/following-links` answers `200 { scopeRequired: true }`
  instead of a 403 without the scope: a 403 `scope_upgrade_required` also raises the app-wide
  "log in again" banner, on every visit, for everyone who hasn't opted in. The page's empty state
  is the ask ("Allow and sign in again" = logout + `/auth/login?returnUrl=/following`). The state
  POST still 403s.
- `/following` (`frontend/src/lib/components/following/FollowingPage.svelte`), account-only in
  `+layout.svelte`; nav entry "From your follows" (`share-2`) after Rooms in the sidebar and the
  mobile switcher. Day / 3 days / Week toggle; rows with avatars + "Maya and 2 others shared
  this", expandable to each sharer's words and their Bluesky post; opened rows dim; × hides.
- Store `frontend/src/lib/stores/followLinks.svelte.ts`: cached per account + window, re-asks 4s
  after any response that started a refresh (up to 6 times) so a first refresh's results land.
- Home lane "Shared by people you follow" (top 8), compact meta label ("Maya shared" /
  "3 shared"): the tile's meta line is sized for "8 min read", and the full sentence overflowed.
- Opening uses `extractArticle` (generalized from `extractRoomArticle` in `utils/roomArticle.ts`).
- **Title fallback, part two:** a bare link with no card anywhere gets a title read off its URL slug
  (`titleFromUrl`: three or more word-like segments, else the host). Covers most of the Phase 0
  bare links without an unfurl.
- Docs: `docs-site/src/content/docs/guide/from-your-follows.md` + a row and section in
  `your-data.md`. No screenshot yet (`e2e-docs/` spec to add).
- Tests: `frontend/src/lib/utils/followLinks.test.ts`; E2E `e2e/following-links.spec.ts` (ask
  without the banner; ranking, comments, window, hide survives reload; Home lane), seeded via
  `seedFollowLinks` in `e2e/seed.ts`.
- **Not built:** undo / a "hidden" view for dismissed links (the toast store only takes link
  actions); restore exists server-side.

### Phase 3: the payoff in the reader — DONE (2026-09-23)

Not a separate group: the Discussion panel's thesis is one merged stream where the network is a
property of a row, so "someone you follow" is a property of a row too.

- `GET /api/v2/following-links/for?url=` (`readFollowLinkSharers`): who you follow shared this URL,
  newest first, over the 7-day window. One indexed read (`idx_follow_link_shares_user_url`, added to
  0082), never a timeline walk; empty `scopeRequired` without the permission. `LIGHT_LIMIT`.
  Dismissing on /following doesn't hide sharers here.
- `followLinkSharersStore` loads per URL when the stream opens; stops asking for the session once
  an answer says `scopeRequired`.
- `utils/discussionFollows.ts` (pure): lane rows by a follow get `followed: true`; follows shares
  the lanes don't carry (reposts, mostly: a repost has no link of its own for Constellation to find)
  become Bluesky rows, deduped against the Bluesky lane once it resolves. Order: followed rows
  first, newest first; everyone else by engagement beneath. A follow who only reposted lands in
  "Also linked by", first.
- Panel: a quiet **You follow** label on the row head; a **People you follow** filter chip beside
  All (cuts across networks). Works in every surface that mounts the panel, feed cards included.
- Known gap: the panel's headline/tab count is the lanes' count, so a follows-only repost isn't
  counted in it.
- Tests: `frontend/src/lib/utils/discussionFollows.test.ts`, backend `/for` cases in
  `follow-links-store.spec.ts`, E2E "leads an article's Discussion with the people you follow".

### Later, only if the hypothesis holds

- **Magazine source.** Feed top links into the daily edition. Needs word counts at generate time
  and a snapshot body path for items with no save rkey (`magazine.svelte.ts` currently assumes
  one).
- **Rooms bridge.** "4 people you follow shared this" is the natural moment to suggest reading
  along; surface rooms your follows joined next to their links.
- **Per-sharer mute** ("hide links from this account" without unfollowing).
- **Digest notification / email** once a day, never live.
- **Onboarding.** On first sign-in, suggest RSS feeds for the sites your follows share most. This
  turns the feature into a cold-start fix for the reader itself.

## Open questions

- **Naming.** "From your follows" is plain but a bit flat. The surface name will end up on the
  landing page, so it is worth a second pass.
- **Replies.** Skipped in v1. A follow replying with a link is often a good recommendation, but
  also often a citation in an argument. Watch for complaints.
- **Linkblog overlap.** A follow who shares via their Skyreader linkblog (standard.site document)
  _and_ cross-posts to Bluesky will appear here via the Bluesky post. That's fine for v1; dedupe
  against linkblog documents later if it reads as noise.
- **Copy for the scope prompt.** Must be honest that Skyreader reads your Following timeline to do
  this, that it keeps links for 7 days, and that nothing is posted.
