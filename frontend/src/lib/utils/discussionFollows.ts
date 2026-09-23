// People you follow, in the Discussion panel. See docs/plans/FOLLOWS_LINKS_PLAN.md.
//
// The panel's rows come from each network's backlink lookup, which answers "who
// linked this" for the whole network. The follows-links store answers a smaller,
// closer question: which of the people YOU follow shared it, read off your own
// Bluesky timeline. Merging the two:
//
//  - A lane row by someone you follow is marked `followed`.
//  - A follows share the lanes don't carry becomes a row of its own. Reposts
//    are the usual case (a repost carries no link of its own, so no backlink
//    finds it), plus posts beyond the lane's cap or not yet indexed.
//  - Followed rows lead the stream, newest first; everyone else keeps the
//    engagement order beneath them. Among strangers, likes are the best signal
//    of what carried. Among the people you chose to follow, who said it wins.
//
// Pure, so the merge is testable without mounting anything.
import type { DiscussionEntryVM } from '$lib/components/articleCardView.types';
import type { FollowLinkSharer } from '$lib/types';
import { byEngagement, newestFirst } from '$lib/utils/discussionSort';
import { cleanDiscussionNote } from '$lib/utils/discussionNote';
import { formatRelativeDate } from '$lib/utils/date';
import { bskyPostUrl } from '$lib/utils/followLinks';

const VERB: Record<FollowLinkSharer['kind'], string> = {
  post: 'posted',
  quote: 'quoted',
  repost: 'reposted',
};

/** A follows share the lanes didn't carry, as a Bluesky row. */
export function followShareEntry(
  s: FollowLinkSharer,
  titles: (string | null | undefined)[]
): DiscussionEntryVM {
  const createdAt = new Date(s.sharedAt).toISOString();
  // A repost's text is the original author's, not the reposter's words.
  const note = s.kind === 'repost' ? null : s.text;
  return {
    did: s.did,
    handle: s.handle,
    displayName: s.name,
    avatar: s.avatar,
    createdAt,
    note,
    url: bskyPostUrl(s.postUri),
    collections: [],
    verb: null,
    quote: null,
    likeCount: null,
    key: `following|${s.did}|${s.postUri}`,
    lane: 'bluesky',
    laneLabel: 'Bluesky',
    laneIcon: 'bluesky',
    headVerb: VERB[s.kind],
    relativeTime: formatRelativeDate(createdAt),
    isoTime: createdAt,
    cleanNote: cleanDiscussionNote(note, titles),
    followed: true,
  };
}

/**
 * Mark and extend the lane rows with the reader's follows.
 *
 * `blueskyEntries` are the Bluesky lane's rows when that lane has resolved
 * (null while it's loading or has nobody): a follow already there is marked
 * rather than repeated. Returns the rows to add; mutates nothing.
 */
export function followExtras(
  sharers: FollowLinkSharer[],
  blueskyDids: Set<string> | null,
  titles: (string | null | undefined)[]
): DiscussionEntryVM[] {
  const seen = new Set<string>();
  const out: DiscussionEntryVM[] = [];
  for (const s of sharers) {
    if (seen.has(s.did) || blueskyDids?.has(s.did)) continue;
    seen.add(s.did);
    out.push(followShareEntry(s, titles));
  }
  return out;
}

/** Followed rows first, newest first among them; the rest by engagement. */
export function byFollowedThenEngagement(a: DiscussionEntryVM, b: DiscussionEntryVM): number {
  const fa = a.followed ? 1 : 0;
  const fb = b.followed ? 1 : 0;
  if (fa !== fb) return fb - fa;
  return fa ? newestFirst(a, b) : byEngagement(a, b);
}
