// Bluesky feeds as sources (docs/plans/BLUESKY_FEEDS_PLAN.md): the pure half.
//
// Turns app.bsky.feed.defs#feedViewPost items (from getTimeline or getFeed) into
// the lean post shape the river renders, and builds the facets for a reply the
// reader writes. Nothing here fetches; the route does that.
//
// Everything in the input is optional: the appview's shapes drift, and a
// malformed item should be skipped, not throw.

export interface BskyActor {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

/** A run of a post's text, with the facet over it (at most one) resolved. */
export interface BskyTextSegment {
  text: string;
  /** A link facet's target. */
  link?: string;
  /** A mention facet's DID. */
  mention?: string;
  /** A hashtag facet's tag, without the '#'. */
  tag?: string;
}

export interface BskyImage {
  thumb: string;
  fullsize: string;
  alt: string;
  aspectRatio?: { width: number; height: number };
}

export interface BskyExternal {
  uri: string;
  title: string;
  description: string;
  thumb?: string;
}

export interface BskyVideo {
  playlist: string;
  thumbnail?: string;
  alt?: string;
  aspectRatio?: { width: number; height: number };
}

export interface StrongRef {
  uri: string;
  cid: string;
}

/** A quoted post, or why it can't be shown. */
export type BskyQuote =
  | {
      uri: string;
      url: string;
      author: BskyActor;
      text: string;
      segments: BskyTextSegment[];
      createdAt: string;
      images?: BskyImage[];
      external?: BskyExternal;
      video?: BskyVideo;
    }
  | { unavailable: 'notFound' | 'blocked' | 'detached' };

export interface BskyPost {
  uri: string;
  cid: string;
  /** The post on bsky.app. */
  url: string;
  author: BskyActor;
  text: string;
  segments: BskyTextSegment[];
  createdAt: string;
  indexedAt: string;
  images?: BskyImage[];
  external?: BskyExternal;
  video?: BskyVideo;
  quote?: BskyQuote;
  replyCount: number;
  repostCount: number;
  likeCount: number;
  quoteCount: number;
  viewer: {
    /** The reader's like record, when they've liked it. */
    like?: string;
    /** The reader's repost record, when they've reposted it. */
    repost?: string;
    replyDisabled?: boolean;
  };
  /** Where this post sits in a thread: what a reply to it should point at. */
  replyRef?: { root: StrongRef; parent: StrongRef };
  /** The post this one replies to, for the "Replying to" line. */
  replyParent?: { author: BskyActor; text: string } | { unavailable: true };
  /** Set when it's in the feed because someone reposted it. */
  repostedBy?: BskyActor;
  /** The feed's own "pinned" marker (a feed generator can pin a post). */
  pinned?: boolean;
  /** Media carries a label that asks to be hidden until clicked. */
  mediaWarning?: string;
  /** When the feed places it: the repost time for a repost, else indexedAt. */
  sortAt: string;
}

interface RawProfile {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  labels?: RawLabel[];
}

interface RawLabel {
  val?: string;
  neg?: boolean;
}

interface RawFacet {
  index?: { byteStart?: number; byteEnd?: number };
  features?: { $type?: string; uri?: string; did?: string; tag?: string }[];
}

interface RawRecord {
  $type?: string;
  text?: string;
  facets?: RawFacet[];
  createdAt?: string;
  reply?: { root?: { uri?: string; cid?: string }; parent?: { uri?: string; cid?: string } };
}

interface RawEmbed {
  $type?: string;
  images?: {
    thumb?: string;
    fullsize?: string;
    alt?: string;
    aspectRatio?: { width: number; height: number };
  }[];
  external?: { uri?: string; title?: string; description?: string; thumb?: string };
  playlist?: string;
  thumbnail?: string;
  alt?: string;
  aspectRatio?: { width: number; height: number };
  media?: RawEmbed;
  // record#view.record is a viewRecord (or a not-found/blocked/detached marker,
  // or a feed/list/starter-pack view); recordWithMedia#view.record is a record#view.
  record?: RawViewRecord & { record?: RawViewRecord };
}

interface RawViewRecord {
  $type?: string;
  uri?: string;
  cid?: string;
  author?: RawProfile;
  value?: RawRecord;
  embeds?: RawEmbed[];
  indexedAt?: string;
  labels?: RawLabel[];
}

interface RawPost {
  uri?: string;
  cid?: string;
  author?: RawProfile;
  record?: RawRecord;
  embed?: RawEmbed;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  quoteCount?: number;
  indexedAt?: string;
  labels?: RawLabel[];
  viewer?: { like?: string; repost?: string; replyDisabled?: boolean };
}

export interface RawFeedItem {
  post?: RawPost;
  reply?: {
    parent?: RawPost & { $type?: string; notFound?: boolean; blocked?: boolean };
  };
  reason?: { $type?: string; by?: RawProfile; indexedAt?: string };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Split a post's text into runs by its facets. Facets index UTF-8 bytes, not
 * JS string positions. Overlapping, out-of-range or featureless facets are
 * dropped (their text stays plain) rather than trusted.
 */
export function segmentText(text: string, facets: RawFacet[] | undefined): BskyTextSegment[] {
  if (!text) return [];
  const bytes = encoder.encode(text);
  const spans = (facets ?? [])
    .map((f) => {
      const start = f.index?.byteStart;
      const end = f.index?.byteEnd;
      if (typeof start !== 'number' || typeof end !== 'number') return null;
      if (start < 0 || end > bytes.length || end <= start) return null;
      const seg: Omit<BskyTextSegment, 'text'> = {};
      for (const feature of f.features ?? []) {
        if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
          seg.link = feature.uri;
        } else if (feature.$type === 'app.bsky.richtext.facet#mention' && feature.did) {
          seg.mention = feature.did;
        } else if (feature.$type === 'app.bsky.richtext.facet#tag' && feature.tag) {
          seg.tag = feature.tag;
        }
      }
      if (!seg.link && !seg.mention && !seg.tag) return null;
      return { start, end, seg };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => a.start - b.start);

  const out: BskyTextSegment[] = [];
  let cursor = 0;
  for (const { start, end, seg } of spans) {
    if (start < cursor) continue; // overlaps the previous facet
    if (start > cursor) out.push({ text: decoder.decode(bytes.slice(cursor, start)) });
    out.push({ text: decoder.decode(bytes.slice(start, end)), ...seg });
    cursor = end;
  }
  if (cursor < bytes.length) out.push({ text: decoder.decode(bytes.slice(cursor)) });
  return out;
}

function actor(p: RawProfile | undefined): BskyActor | null {
  if (!p?.did) return null;
  return {
    did: p.did,
    handle: p.handle ?? p.did,
    ...(p.displayName ? { displayName: p.displayName } : {}),
    ...(p.avatar ? { avatar: p.avatar } : {}),
  };
}

/** The bsky.app page for a post at-uri. */
export function postWebUrl(uri: string, handleOrDid?: string): string {
  const match = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match) return 'https://bsky.app';
  return `https://bsky.app/profile/${handleOrDid || match[1]}/post/${match[2]}`;
}

// Self-labels and moderation labels that Bluesky hides media behind by default.
// Adult-content preferences live in the reader's Bluesky settings, which we
// don't read; hiding until clicked is the conservative default.
const MEDIA_WARNING_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore']);

function mediaWarning(...labelSets: (RawLabel[] | undefined)[]): string | undefined {
  for (const labels of labelSets) {
    for (const l of labels ?? []) {
      if (!l.neg && l.val && MEDIA_WARNING_LABELS.has(l.val)) return l.val;
    }
  }
  return undefined;
}

interface Media {
  images?: BskyImage[];
  external?: BskyExternal;
  video?: BskyVideo;
}

function media(embed: RawEmbed | undefined): Media {
  if (!embed?.$type) return {};
  switch (embed.$type) {
    case 'app.bsky.embed.images#view': {
      const images = (embed.images ?? [])
        .filter((i) => i.thumb && i.fullsize)
        .map((i) => ({
          thumb: i.thumb!,
          fullsize: i.fullsize!,
          alt: i.alt ?? '',
          ...(i.aspectRatio ? { aspectRatio: i.aspectRatio } : {}),
        }));
      return images.length ? { images } : {};
    }
    case 'app.bsky.embed.external#view': {
      const e = embed.external;
      if (!e?.uri) return {};
      return {
        external: {
          uri: e.uri,
          title: e.title ?? '',
          description: e.description ?? '',
          ...(e.thumb ? { thumb: e.thumb } : {}),
        },
      };
    }
    case 'app.bsky.embed.video#view':
      if (!embed.playlist) return {};
      return {
        video: {
          playlist: embed.playlist,
          ...(embed.thumbnail ? { thumbnail: embed.thumbnail } : {}),
          ...(embed.alt ? { alt: embed.alt } : {}),
          ...(embed.aspectRatio ? { aspectRatio: embed.aspectRatio } : {}),
        },
      };
    case 'app.bsky.embed.recordWithMedia#view':
      return media(embed.media);
    default:
      return {};
  }
}

function quote(embed: RawEmbed | undefined): BskyQuote | undefined {
  if (!embed?.$type) return undefined;
  let view: RawViewRecord | undefined;
  if (embed.$type === 'app.bsky.embed.record#view') view = embed.record;
  else if (embed.$type === 'app.bsky.embed.recordWithMedia#view') view = embed.record?.record;
  if (!view?.$type) return undefined;

  switch (view.$type) {
    case 'app.bsky.embed.record#viewNotFound':
      return { unavailable: 'notFound' };
    case 'app.bsky.embed.record#viewBlocked':
      return { unavailable: 'blocked' };
    case 'app.bsky.embed.record#viewDetached':
      return { unavailable: 'detached' };
    case 'app.bsky.embed.record#viewRecord': {
      const author = actor(view.author);
      if (!view.uri || !author) return undefined;
      const text = view.value?.text ?? '';
      return {
        uri: view.uri,
        url: postWebUrl(view.uri, author.handle),
        author,
        text,
        segments: segmentText(text, view.value?.facets),
        createdAt: view.value?.createdAt ?? view.indexedAt ?? '',
        ...media(view.embeds?.[0]),
      };
    }
    default:
      // A quoted feed, list or starter pack: not a post; leave it out.
      return undefined;
  }
}

function strongRef(ref: { uri?: string; cid?: string } | undefined): StrongRef | null {
  return ref?.uri && ref.cid ? { uri: ref.uri, cid: ref.cid } : null;
}

const PARENT_TEXT_MAX = 200;

/** One feed item as a river post, or null if it isn't a readable post. */
export function normalizeFeedItem(item: RawFeedItem): BskyPost | null {
  const post = item.post;
  const author = actor(post?.author);
  if (!post?.uri || !post.cid || !author) return null;
  const record = post.record ?? {};
  const text = record.text ?? '';

  // A reply to this post points at it as the parent, and at its thread's root:
  // its own root when it's a reply itself, else itself.
  const self = { uri: post.uri, cid: post.cid };
  const root = strongRef(record.reply?.root) ?? self;

  let replyParent: BskyPost['replyParent'];
  if (record.reply) {
    const parent = item.reply?.parent;
    const parentAuthor = actor(parent?.author);
    replyParent =
      parentAuthor && parent?.record
        ? {
            author: parentAuthor,
            text: (parent.record.text ?? '').slice(0, PARENT_TEXT_MAX),
          }
        : { unavailable: true };
  }

  const isRepost = item.reason?.$type === 'app.bsky.feed.defs#reasonRepost';
  const repostedBy = isRepost ? actor(item.reason?.by) : null;
  const warning = mediaWarning(post.labels, post.author?.labels);

  return {
    uri: post.uri,
    cid: post.cid,
    url: postWebUrl(post.uri, author.handle),
    author,
    text,
    segments: segmentText(text, record.facets),
    createdAt: record.createdAt ?? post.indexedAt ?? '',
    indexedAt: post.indexedAt ?? record.createdAt ?? '',
    ...media(post.embed),
    ...(quote(post.embed) ? { quote: quote(post.embed) } : {}),
    replyCount: post.replyCount ?? 0,
    repostCount: post.repostCount ?? 0,
    likeCount: post.likeCount ?? 0,
    quoteCount: post.quoteCount ?? 0,
    viewer: {
      ...(post.viewer?.like ? { like: post.viewer.like } : {}),
      ...(post.viewer?.repost ? { repost: post.viewer.repost } : {}),
      ...(post.viewer?.replyDisabled ? { replyDisabled: true } : {}),
    },
    replyRef: { root, parent: self },
    ...(replyParent ? { replyParent } : {}),
    ...(repostedBy ? { repostedBy } : {}),
    ...(item.reason?.$type === 'app.bsky.feed.defs#reasonPin' ? { pinned: true } : {}),
    ...(warning ? { mediaWarning: warning } : {}),
    sortAt: (isRepost && item.reason?.indexedAt) || post.indexedAt || record.createdAt || '',
  };
}

/** A page of feed items as river posts, skipping what can't be shown. */
export function normalizeFeed(items: RawFeedItem[] | undefined): BskyPost[] {
  const out: BskyPost[] = [];
  for (const item of items ?? []) {
    const post = normalizeFeedItem(item);
    if (post) out.push(post);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing a reply
// ---------------------------------------------------------------------------

/** Bluesky's post length limit, in graphemes. */
export const POST_MAX_GRAPHEMES = 300;

export function graphemeLength(text: string): number {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return [...text].length;
  let n = 0;
  for (const _ of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++;
  return n;
}

export interface PostFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#mention'; did: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >;
}

function byteLen(s: string): number {
  return encoder.encode(s).length;
}

// Close to what Bluesky's own composer detects: http(s) URLs (bare domains are
// left alone, to avoid false positives), @handle.tld mentions, and #hashtags
// that aren't all digits.
const URL_RE = /(^|[\s(])(https?:\/\/[^\s<>"'`]+)/g;
const MENTION_RE =
  /(^|[\s(])@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})/g;
const TAG_RE = /(^|\s)#([^\s#.,!?;:()[\]{}"'`]{1,64})/g;

/** Trailing punctuation a URL at the end of a sentence shouldn't swallow. */
function trimUrl(url: string): string {
  let out = url.replace(/[.,;:!?]+$/, '');
  // A closing paren belongs to the URL only if it opened one.
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1);
  }
  return out;
}

/** A detected facet; a mention holds its handle until it's resolved to a DID. */
export type DetectedFacet = PostFacet | { handle: string; index: PostFacet['index'] };

export interface DetectedFacets {
  facets: DetectedFacet[];
  /** Handles found in the text, for the caller to resolve to DIDs. */
  handles: string[];
}

/**
 * Detect link, mention and tag facets in reply text. Mentions come back as
 * handles with a placeholder; `resolveMentions` fills in the DIDs (or drops the
 * facet when a handle doesn't resolve, leaving plain text).
 */
export function detectFacets(text: string): DetectedFacets {
  const facets: DetectedFacet[] = [];
  const handles = new Set<string>();

  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[2]);
    const at = (m.index ?? 0) + m[1].length;
    const byteStart = byteLen(text.slice(0, at));
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLen(url) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    });
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const at = (m.index ?? 0) + m[1].length;
    const byteStart = byteLen(text.slice(0, at));
    handles.add(m[2].toLowerCase());
    facets.push({
      handle: m[2].toLowerCase(),
      index: { byteStart, byteEnd: byteStart + byteLen(`@${m[2]}`) },
    });
  }
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[2].replace(/[.,;:!?]+$/, '');
    if (!tag || /^\d+$/.test(tag)) continue;
    const at = (m.index ?? 0) + m[1].length;
    const byteStart = byteLen(text.slice(0, at));
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLen(`#${tag}`) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    });
  }

  // A URL can contain an @ or a # (a fragment): the earlier-starting, longer
  // span wins, and anything inside it is dropped.
  facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
  const kept: DetectedFacet[] = [];
  let end = 0;
  for (const f of facets) {
    if (f.index.byteStart < end) continue;
    kept.push(f);
    end = f.index.byteEnd;
  }
  return {
    facets: kept,
    handles: [...handles].filter((h) => kept.some((f) => 'handle' in f && f.handle === h)),
  };
}

/** Swap resolved DIDs into mention placeholders; unresolved mentions drop out. */
export function resolveMentions(detected: DetectedFacet[], dids: Map<string, string>): PostFacet[] {
  const out: PostFacet[] = [];
  for (const f of detected) {
    if ('handle' in f) {
      const did = dids.get(f.handle);
      if (did) {
        out.push({ index: f.index, features: [{ $type: 'app.bsky.richtext.facet#mention', did }] });
      }
    } else {
      out.push(f);
    }
  }
  return out;
}
