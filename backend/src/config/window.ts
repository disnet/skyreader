/**
 * K — the canonical per-feed article window.
 *
 * One number, enforced in three places that used to disagree:
 *
 *  - the timeline's cold start (`COLD_START_PER_FEED`, timeline.ts) — what a
 *    fresh device receives per feed,
 *  - the server-computed unread counts (timeline.ts) — what every device
 *    displays,
 *  - the client's local cap (`MAX_ARTICLES_PER_FEED`,
 *    `frontend/src/lib/services/articleMerge.ts`) — what an established device
 *    keeps.
 *
 * They were 30 / — / 100, which is why two devices signed into one account
 * showed different unread numbers for the same feed no matter how well read
 * state synced: they were counting over different sets. Anything that changes
 * this value must change the frontend constant in the same commit.
 *
 * 100 rather than 50: a cold start is rare and paged (COLD_START_MAX_ITEMS
 * bounds each request), while divergence is daily.
 */
export const ARTICLE_WINDOW_PER_FEED = 100;
