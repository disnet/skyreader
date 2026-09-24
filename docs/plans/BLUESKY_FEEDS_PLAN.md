# Bluesky feeds as sources: a minimal Bluesky client in the river

> Your Bluesky **Following** timeline, and the feeds you pinned or saved in Bluesky, become sources
> a channel can name. Posts read as river rows with the few things a reader does to one: reply,
> repost, like, and read what it links to in the calm reader.

Builds on [From your follows](FOLLOWS_LINKS_PLAN.md), which already reads the timeline through the
reader's PDS but keeps only the links. That source stays as it is: grouped links, the **Shared by**
pill, the Discussion rows. This is the other half: the posts themselves.

## Decisions

- **Channel sources, the feed's own order.** A feed is a source key, `{feedUri}~bskyfeed`
  (`'following'` for the timeline, else an `app.bsky.feed.generator` at-uri). Like the follows
  source it is **never part of "All sources"**, a category, a type filter, or unread counts; a
  channel shows a feed only by naming it, so a busy timeline can't flood the river. A channel that
  is one feed and nothing else (`feedView.bskyFeedOnly`) keeps Bluesky's order (a custom feed is
  ranked, not chronological) and pages by cursor. Mixed with anything, posts sort by `sortAt` (the
  repost time for a repost).
- **Posts are read live, never stored.** `GET /api/v2/bsky/feed?uri=&cursor=` proxies `getTimeline`
  or `getFeed` through the PDS (`atproto-proxy: did:web:api.bsky.app#bsky_appview`) and normalizes
  (`services/bsky-posts.ts`: facets split into text segments by UTF-8 byte offsets, embeds, counts,
  the reader's like/repost records, reply refs). Only the subscription is in D1 (`bsky_feeds`,
  migration 0085, cascade from `users`). The client keeps pages in memory (`bskyFeeds.svelte.ts`,
  2-minute reuse).
- **No read state.** A post isn't an article; the read filter, tags and mark-read skip it. Its
  link card opens through `extractArticle` into a synthetic `saved` item (the follows-link path);
  the bookmark saves the linked page.
- **Feeds offered:** Following plus the feeds in the reader's Bluesky preferences
  (`savedFeedsPrefV2`, falling back to v1), pinned first. Lists and paste-a-URL are not built.
- **Adding a feed makes its channel** (`utils/bskyFeedChannel.ts`, like `followsChannel.ts`).
  Removing the source deletes its own channel and strips the key from channels that mixed it in.

## Permissions (progressive, see OAUTH_SCOPES.md)

| Feature        | Scopes                                                                                   | Asked when                                               |
| -------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `follows`      | `rpc:app.bsky.feed.getTimeline?aud=…`                                                    | already granted by From your follows; reads the timeline |
| `bluesky`      | `follows` + `rpc:app.bsky.feed.getFeed?aud=…`, `rpc:app.bsky.actor.getPreferences?aud=…` | Manage Sources / a channel's empty state                 |
| `blueskyWrite` | `repo:app.bsky.feed.like`, `repo:app.bsky.feed.repost`, `repo:app.bsky.feed.post`        | the first like, repost or reply                          |

Reads answer `200 { scopeRequired: true }`, not a 403, so a channel never raises the app-wide
banner. Writes 403 with `feature: 'blueskyWrite'`, but the card asks inline before sending one (the
**l** shortcut asks with a toast), so a reply draft is never lost to the redirect.

**Unverified:** that Bluesky's auth server grants the `getFeed` / `getPreferences` rpc scopes
byte-identically, as it does `getTimeline` (Phase 0 of the follows plan), and that the PDS checks
`getPreferences` against the appview audience. `getPreferences` is answered by the PDS itself, so
it's sent without the proxy header. Check both against a real account before shipping; if the
grant comes back different, `grantsScopes()` will fail the gate and the section says so.

## Routes (`backend/src/routes/bsky.ts`)

- `GET /api/v2/bsky/feeds[?saved=1]` `{ access: {timeline, feeds, write}, feeds, saved?, savedError? }`
- `POST|DELETE /api/v2/bsky/feeds { uri }` (≤ 50 per reader; metadata from the public appview's
  `getFeedGenerators`; adding needs no permission)
- `GET /api/v2/bsky/feed?uri=&cursor=&limit=` (≤ 100, default 30)
- `POST /api/v2/bsky/like|repost { uri, cid }` → `{ uri }`; `DELETE { uri }` only for the reader's
  own record in that collection
- `POST /api/v2/bsky/post { text, reply?: { root, parent } }`: ≤ 300 graphemes; link, @mention
  (resolved, ≤ 10) and #tag facets detected server-side

## Frontend

- `BskyPostCard.svelte`: repost/pinned context, avatar + byline, "Replying to", rich text, images,
  video (thumbnail, plays on Bluesky), link card, quote, labeled media behind **Show**, actions
  (reply, repost, like, save link, read in Skyreader, open on Bluesky), inline permission ask,
  inline reply box (Cmd/Ctrl+Enter). Done states use the one blue (DESIGN.md), not Bluesky's
  pink/green.
- `feedView`: `BskyPostRow` in `RiverItem`; `shownBskyFeedUris`, `bskyFeedOnly`; `loadMore` pages a
  feed on its own when the list nears its end, and a mixed feed once the rows shown pass its oldest
  loaded post.
- Pickers (toolbar, mobile sheet, channel modal) list added feeds in Include-only mode; the follows
  source's label became **Links from people you follow** so it doesn't read like the timeline.
- Manage Sources: **Bluesky feeds** section (`BlueskyFeedsSection.svelte`).
- Keyboard: `o` opens the link (else the post), `s` saves the link, Enter reads it, `l` likes.

## Tests

`backend/test/bsky-posts.spec.ts`, `backend/test/bsky-routes.spec.ts`,
`frontend/src/lib/stores/feedViewBskyPosts.component.test.ts`,
`frontend/src/lib/stores/bskyFeeds.component.test.ts`, `frontend/src/lib/utils/bskyPosts.test.ts`,
`e2e/bluesky-feeds.spec.ts` (routes the feed pages and writes; the E2E session has no PDS).

## Not built

Lists as sources, custom feeds by URL, threads (a post's replies open on Bluesky), quote posting,
image or video upload, an in-app video player, notifications, honoring the reader's Bluesky
adult-content and label preferences (labeled media is hidden until clicked), a Home lane.
