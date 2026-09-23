// From your follows: pull the links people you follow share out of your Bluesky
// Following timeline. See docs/plans/FOLLOWS_LINKS_PLAN.md.
//
// This module is the pure half: given timeline pages (app.bsky.feed.getTimeline
// `feed` items), decide which items are link shares and flatten them into rows.
// Paging and storage live with the caller.

import { normalizeArticleUrl } from '../utils/url-normalize';

// The slice of app.bsky.feed.defs#feedViewPost we read. Everything is optional
// because the appview's shapes drift and a malformed item should be skipped,
// not throw.
export interface TimelineProfile {
  did: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
}

interface Facet {
  features?: { $type?: string; uri?: string }[];
}

interface ExternalView {
  uri?: string;
  title?: string;
  description?: string;
  thumb?: string;
}

interface EmbedView {
  $type?: string;
  external?: ExternalView;
  media?: EmbedView; // recordWithMedia#view
  // record#view wraps a viewRecord (the quoted post, with its own embeds);
  // recordWithMedia#view wraps a record#view.
  record?: EmbedView & { embeds?: EmbedView[] };
}

export interface TimelineItem {
  post?: {
    uri?: string;
    author?: TimelineProfile;
    record?: {
      text?: string;
      facets?: Facet[];
      reply?: unknown;
    };
    embed?: EmbedView;
    indexedAt?: string;
  };
  reason?: {
    $type?: string;
    by?: TimelineProfile;
    indexedAt?: string;
  };
}

export type ShareKind = 'post' | 'quote' | 'repost';

export interface LinkShare {
  postUri: string;
  sharer: TimelineProfile;
  kind: ShareKind;
  url: string;
  urlNormalized: string;
  text: string | null;
  card: { title?: string; description?: string; thumb?: string } | null;
  sharedAt: string;
}

const REPOST = 'app.bsky.feed.defs#reasonRepost';
const EXTERNAL_VIEW = 'app.bsky.embed.external#view';
const RECORD_VIEW = 'app.bsky.embed.record#view';
const RECORD_WITH_MEDIA_VIEW = 'app.bsky.embed.recordWithMedia#view';
const LINK_FACET = 'app.bsky.richtext.facet#link';

// A sharer's comment is most of the value, but a post can run to 300 graphemes
// and we only ever show a line or two of it.
export const SHARE_TEXT_MAX = 300;

// Links that point back into the social layer itself rather than at something to
// read. Matched on the host and its subdomains.
const SKIP_HOSTS = ['bsky.app', 'bsky.social', 'go.bsky.app', 'skyreader.app'];

function skippedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return SKIP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function externalOf(embed: EmbedView | undefined): ExternalView | null {
  if (!embed) return null;
  if (embed.$type === EXTERNAL_VIEW && embed.external?.uri) return embed.external;
  if (embed.$type === RECORD_WITH_MEDIA_VIEW) return externalOf(embed.media);
  return null;
}

// The link card on the post being quoted, if any. Quoting a link post with a
// comment is sharing that link, and the comment is exactly what we want to show.
function quotedExternalOf(embed: EmbedView | undefined): ExternalView | null {
  if (!embed) return null;
  const quote =
    embed.$type === RECORD_VIEW
      ? embed.record
      : embed.$type === RECORD_WITH_MEDIA_VIEW
        ? embed.record?.record
        : undefined;
  for (const inner of quote?.embeds ?? []) {
    const external = externalOf(inner);
    if (external) return external;
  }
  return null;
}

function firstFacetLink(facets: Facet[] | undefined): string | null {
  for (const facet of facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature.$type === LINK_FACET && feature.uri) return feature.uri;
    }
  }
  return null;
}

/**
 * Flatten one timeline item into a link share, or null when it isn't one.
 *
 * Takes top-level posts, quote posts and reposts that carry an external link.
 * Skips replies (conversation, not recommendation), the viewer's own posts and
 * reposts, and links back into Bluesky or Skyreader. One link per post: the
 * post's own link card wins, then its first link facet, then the card on the
 * post it quotes.
 */
export function extractLinkShare(item: TimelineItem, viewerDid: string): LinkShare | null {
  const post = item.post;
  if (!post?.uri || !post.author?.did || !post.indexedAt) return null;
  if (post.record?.reply) return null;

  const isRepost = item.reason?.$type === REPOST;
  if (item.reason && !isRepost) return null; // e.g. reasonPin
  const sharer = isRepost ? item.reason?.by : post.author;
  if (!sharer?.did || sharer.did === viewerDid) return null;

  const ownExternal = externalOf(post.embed);
  const facetLink = ownExternal ? null : firstFacetLink(post.record?.facets);
  const external = ownExternal ?? (facetLink ? null : quotedExternalOf(post.embed));
  const url = external?.uri ?? facetLink;
  if (!url || skippedHost(url)) return null;
  const urlNormalized = normalizeArticleUrl(url);
  if (!urlNormalized) return null;

  const embedType = post.embed?.$type;
  const kind: ShareKind = isRepost
    ? 'repost'
    : embedType === RECORD_VIEW || embedType === RECORD_WITH_MEDIA_VIEW
      ? 'quote'
      : 'post';

  const text = post.record?.text?.trim() || null;

  return {
    postUri: post.uri,
    sharer: {
      did: sharer.did,
      handle: sharer.handle,
      displayName: sharer.displayName,
      avatar: sharer.avatar,
    },
    kind,
    url,
    urlNormalized,
    // For a repost the text is the original author's, not the sharer's, so it
    // isn't their comment. Keep it anyway: it's what they chose to amplify.
    text: text ? text.slice(0, SHARE_TEXT_MAX) : null,
    card: external
      ? { title: external.title, description: external.description, thumb: external.thumb }
      : null,
    sharedAt: (isRepost ? item.reason?.indexedAt : undefined) ?? post.indexedAt,
  };
}

export function extractLinkShares(items: TimelineItem[], viewerDid: string): LinkShare[] {
  const out: LinkShare[] = [];
  for (const item of items) {
    const share = extractLinkShare(item, viewerDid);
    if (share) out.push(share);
  }
  return out;
}
