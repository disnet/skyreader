// A Bluesky thread read as one article. bsky.app is a script-rendered app, so a
// fetch of a post's page holds no post; the public appview serves the thread as
// JSON instead (app.bsky.feed.getPostThread). From it we keep only the author's
// own run of posts, in order, and write them out as one HTML document for the
// ordinary extractor: the way a long thread reads when someone posts an essay in
// pieces. Replies from anyone else are left out.
//
// Any post in the thread can be the one linked: the run is followed up through
// its parents and down through the author's own replies to themselves.

const APPVIEW = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread';

// How far below a post one request reaches. getPostThread returns every reply in
// that window, not just the author's, so a long reach on a busy post is a big
// response; a run longer than this continues from its last post.
const DEPTH = 100;
// Continuations after the first request, so the longest thread we read is about
// DEPTH * (1 + MAX_CONTINUATIONS) posts. Longer threads keep what was read.
const MAX_CONTINUATIONS = 4;
// No continuation starts this long after the first request: /extract's whole
// budget has to fit under the server's idleTimeout (see EXTRACT_FETCH_TIMEOUT_MS in
// app.ts, idleTimeout in index.ts), so a slow appview ends the thread early
// rather than the request.
const CONTINUE_WITHIN_MS = 8 * 1000;
// Ancestors are a single chain (no siblings), so reaching all the way up is cheap.
const PARENT_HEIGHT = 1000;

// The label an author sets to ask that their posts not be shown to people who
// aren't signed in. Their thread is left to the ordinary fetch, as before.
const NO_UNAUTHENTICATED = '!no-unauthenticated';

function hidden(author: Author | undefined): boolean {
  return !!author?.labels?.some((l) => l.val === NO_UNAUTHENTICATED);
}

/** Fetches a URL as text; null when it answered an error. */
export type GetText = (url: string, accept: string) => Promise<string | null>;

// The appview's thread shapes, as far as we read them.
interface Author {
  did: string;
  handle?: string;
  displayName?: string;
  labels?: Array<{ val?: string }>;
}
interface Facet {
  index?: { byteStart?: number; byteEnd?: number };
  features?: Array<{ $type?: string; uri?: string; did?: string; tag?: string }>;
}
export interface PostView {
  uri: string;
  author: Author;
  record: { text?: string; facets?: Facet[]; createdAt?: string };
  embed?: Record<string, unknown>;
  replyCount?: number;
  indexedAt?: string;
}
export interface ThreadNode {
  $type?: string;
  post?: PostView;
  parent?: ThreadNode;
  replies?: ThreadNode[];
}

const POST_PATH_RE = /^\/profile\/([^/]+)\/post\/([a-z0-9]+)\/?$/i;

/** The post a bsky.app URL names, as an at:// URI; null for any other URL. */
export function bskyPostUri(url: URL): string | null {
  if (url.hostname !== 'bsky.app' && url.hostname !== 'www.bsky.app') return null;
  const match = POST_PATH_RE.exec(url.pathname);
  if (!match) return null;
  // The actor is a handle or a DID; the appview resolves either inside an at:// URI.
  const actor = decodeURIComponent(match[1]);
  if (!/^(did:[a-z]+:[a-zA-Z0-9._:%-]+|[a-zA-Z0-9.-]+)$/.test(actor)) return null;
  return `at://${actor}/app.bsky.feed.post/${match[2]}`;
}

/** Whether a URL is a bsky.app post page, read as its author's thread. */
export function isBskyPostUrl(rawUrl: string): boolean {
  try {
    return bskyPostUri(new URL(rawUrl)) !== null;
  } catch {
    return false;
  }
}

function isPost(node: ThreadNode | null | undefined): node is ThreadNode & { post: PostView } {
  return !!node && node.$type === 'app.bsky.feed.defs#threadViewPost' && !!node.post;
}

/** The author's own reply to `node`, the earliest when they replied more than once. */
function selfReply(node: ThreadNode, did: string): (ThreadNode & { post: PostView }) | null {
  const own = (node.replies ?? []).filter(
    (r): r is ThreadNode & { post: PostView } => isPost(r) && r.post.author.did === did
  );
  own.sort((a, b) =>
    (a.post.record.createdAt ?? a.post.indexedAt ?? '').localeCompare(
      b.post.record.createdAt ?? b.post.indexedAt ?? ''
    )
  );
  return own[0] ?? null;
}

/**
 * The author's run of posts through `anchor`: up through parents by the same
 * author, then down through their replies to themselves. `last` is the node the
 * run ends on, for continuing a run cut off by the request's depth.
 */
export function threadRun(anchor: ThreadNode & { post: PostView }): {
  posts: PostView[];
  last: ThreadNode & { post: PostView };
  /** Who the run's first post replies to, when it's a reply to someone else. */
  replyingTo: Author | null;
} {
  const did = anchor.post.author.did;
  const above: PostView[] = [];
  let top: ThreadNode = anchor;
  while (isPost(top.parent) && top.parent.post.author.did === did) {
    const parent: ThreadNode & { post: PostView } = top.parent;
    above.unshift(parent.post);
    top = parent;
  }
  const replyingTo = isPost(top.parent) ? top.parent.post.author : null;

  const below: PostView[] = [];
  let last = anchor;
  for (let next = selfReply(anchor, did); next; next = selfReply(next, did)) {
    below.push(next.post);
    last = next;
  }
  return { posts: [...above, anchor.post, ...below], last, replyingTo };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function httpUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** bsky.app's page for a post's at:// URI. */
export function postPageUrl(uri: string): string | null {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  return match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : null;
}

function authorName(author: Author): string {
  return str(author.displayName)?.trim() || (author.handle ? `@${author.handle}` : author.did);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A post's text as HTML: its links, mentions and tags as links (facets index
 * the text by UTF-8 byte), blank lines as paragraph breaks.
 */
export function postTextHtml(text: string, facets: Facet[] = []): string {
  const bytes = encoder.encode(text);
  const spans = facets
    .map((f) => {
      const start = f.index?.byteStart;
      const end = f.index?.byteEnd;
      if (typeof start !== 'number' || typeof end !== 'number') return null;
      if (start < 0 || end > bytes.length || start >= end) return null;
      // An index inside a multi-byte character is a broken facet.
      const midChar = (i: number) => i < bytes.length && (bytes[i] & 0xc0) === 0x80;
      if (midChar(start) || midChar(end)) return null;
      let href: string | null = null;
      for (const feature of f.features ?? []) {
        if (feature.$type === 'app.bsky.richtext.facet#link') href = httpUrl(feature.uri);
        else if (feature.$type === 'app.bsky.richtext.facet#mention' && str(feature.did))
          href = `https://bsky.app/profile/${feature.did}`;
        else if (feature.$type === 'app.bsky.richtext.facet#tag' && str(feature.tag))
          href = `https://bsky.app/hashtag/${encodeURIComponent(feature.tag!)}`;
        if (href) break;
      }
      return href ? { start, end, href } : null;
    })
    .filter((s): s is { start: number; end: number; href: string } => s !== null)
    .sort((a, b) => a.start - b.start);

  let out = '';
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue; // overlapping facets: keep the first
    out += escapeHtml(decoder.decode(bytes.slice(at, span.start)));
    // A link's text stays in one paragraph.
    const label = decoder.decode(bytes.slice(span.start, span.end)).replace(/\s*\n\s*/g, ' ');
    out += `<a href="${escapeHtml(span.href)}">${escapeHtml(label)}</a>`;
    at = span.end;
  }
  out += escapeHtml(decoder.decode(bytes.slice(at)));

  return out
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function imagesHtml(view: Record<string, unknown>): string {
  const images = Array.isArray(view.images) ? view.images : [];
  return images
    .map((img: Record<string, unknown>) => {
      const src = httpUrl(img?.fullsize) ?? httpUrl(img?.thumb);
      if (!src) return '';
      const alt = str(img.alt) ?? '';
      return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"></figure>`;
    })
    .join('');
}

function mediaHtml(view: Record<string, unknown>, postUrl: string | null): string {
  switch (view.$type) {
    case 'app.bsky.embed.images#view':
      return imagesHtml(view);
    case 'app.bsky.embed.video#view': {
      // The video is an HLS playlist most browsers can't play from a plain
      // <video>, so it reads as its poster frame and a link to watch it.
      const thumb = httpUrl(view.thumbnail);
      const alt = str(view.alt) ?? '';
      const poster = thumb
        ? `<figure><img src="${escapeHtml(thumb)}" alt="${escapeHtml(alt)}"></figure>`
        : '';
      const link = postUrl
        ? `<p><a href="${escapeHtml(postUrl)}">Watch the video on Bluesky</a></p>`
        : '';
      return poster + link;
    }
    case 'app.bsky.embed.external#view': {
      const external = (view.external ?? {}) as Record<string, unknown>;
      const href = httpUrl(external.uri);
      if (!href) return '';
      const title = str(external.title) ?? href;
      return `<p><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></p>`;
    }
    default:
      return '';
  }
}

function quoteHtml(record: Record<string, unknown> | undefined): string {
  if (!record || record.$type !== 'app.bsky.embed.record#viewRecord') return '';
  const value = (record.value ?? {}) as { text?: string; facets?: Facet[] };
  const author = record.author as Author | undefined;
  const href = typeof record.uri === 'string' ? postPageUrl(record.uri) : null;
  // A quoted author hidden from signed-out readers stays a link, as on bsky.app.
  if (hidden(author)) {
    return href ? `<p><a href="${escapeHtml(href)}">A quoted post on Bluesky</a></p>` : '';
  }
  const text = str(value.text) ? postTextHtml(value.text!, value.facets) : '';
  const embeds = Array.isArray(record.embeds) ? (record.embeds as Record<string, unknown>[]) : [];
  const media = embeds
    .map((e) =>
      e.$type === 'app.bsky.embed.recordWithMedia#view'
        ? mediaHtml((e.media ?? {}) as Record<string, unknown>, href)
        : mediaHtml(e, href)
    )
    .join('');
  const who = author ? escapeHtml(authorName(author)) : 'A post';
  const cite = href ? `<p>— ${who}, <a href="${escapeHtml(href)}">on Bluesky</a></p>` : '';
  if (!text && !media) return '';
  return `<blockquote>${text}${media}${cite}</blockquote>`;
}

function embedHtml(embed: Record<string, unknown> | undefined, postUrl: string | null): string {
  if (!embed) return '';
  switch (embed.$type) {
    case 'app.bsky.embed.record#view':
      return quoteHtml(embed.record as Record<string, unknown> | undefined);
    case 'app.bsky.embed.recordWithMedia#view':
      return (
        mediaHtml((embed.media ?? {}) as Record<string, unknown>, postUrl) +
        quoteHtml(
          ((embed.record ?? {}) as Record<string, unknown>).record as
            Record<string, unknown> | undefined
        )
      );
    default:
      return mediaHtml(embed, postUrl);
  }
}

function firstImage(embed: Record<string, unknown> | undefined): string | null {
  if (!embed) return null;
  const media =
    embed.$type === 'app.bsky.embed.recordWithMedia#view'
      ? ((embed.media ?? {}) as Record<string, unknown>)
      : embed;
  if (media.$type === 'app.bsky.embed.images#view' && Array.isArray(media.images)) {
    return httpUrl(media.images[0]?.fullsize);
  }
  if (media.$type === 'app.bsky.embed.video#view') return httpUrl(media.thumbnail);
  return null;
}

/** A title from the thread's opening words: its first line, cut at a word. */
export function threadTitle(text: string | undefined, author: Author): string {
  const line =
    (text ?? '')
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  if (!line) return `A thread by ${authorName(author)}`;
  const MAX = 90;
  const chars = Array.from(line); // by code point, so an emoji isn't cut in half
  if (chars.length <= MAX) return line;
  const cut = chars.slice(0, MAX).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/**
 * A page's text as an HTML document for the extractor, with the details the
 * extractor should be told rather than left to find. A thread's title, summary
 * and picture all repeat its opening, and Defuddle strips a lead that matches
 * its title or description, and the body image that matches og:image; so they
 * travel beside the document instead of in its <head>.
 */
export interface SiteDocument {
  html: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
}

/** The author's run of posts as one document; null when there's nothing to read. */
export function threadHtml(
  posts: PostView[],
  replyingTo: Author | null = null
): SiteDocument | null {
  if (posts.length === 0) return null;
  const first = posts[0];
  const author = first.author;
  const body = posts
    .map((post) => {
      const postUrl = postPageUrl(post.uri);
      const text = str(post.record.text) ? postTextHtml(post.record.text!, post.record.facets) : '';
      return text + embedHtml(post.embed, postUrl);
    })
    .join('');
  if (!body) return null;

  // A run that starts as a reply to someone else says so, so its opening line
  // isn't read as out of nowhere.
  const lead =
    replyingTo && !hidden(replyingTo)
      ? `<p><em>Replying to <a href="https://bsky.app/profile/${escapeHtml(replyingTo.did)}">${escapeHtml(
          replyingTo.handle ? `@${replyingTo.handle}` : authorName(replyingTo)
        )}</a></em></p>`
      : '';

  const title = threadTitle(first.record.text, author);
  const published = str(first.record.createdAt) ?? str(first.indexedAt);
  const opening = str(first.record.text)?.replace(/\s+/g, ' ').trim();
  const description = opening ? Array.from(opening).slice(0, 300).join('') : null;
  const image = posts.map((p) => firstImage(p.embed)).find(Boolean) ?? null;
  const head = [
    `<meta name="author" content="${escapeHtml(authorName(author))}">`,
    published && `<meta property="article:published_time" content="${escapeHtml(published)}">`,
  ]
    .filter(Boolean)
    .join('');
  return {
    html: `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body><article>${lead}${body}</article></body></html>`,
    title,
    description,
    image,
  };
}

function threadUrl(uri: string, depth: number, parentHeight: number): string {
  const params = new URLSearchParams({
    uri,
    depth: String(depth),
    parentHeight: String(parentHeight),
  });
  return `${APPVIEW}?${params}`;
}

async function getThread(get: GetText, url: string): Promise<ThreadNode | null> {
  const body = await get(url, 'application/json');
  if (!body) return null;
  try {
    const node = (JSON.parse(body) as { thread?: ThreadNode }).thread;
    return node ?? null;
  } catch {
    return null;
  }
}

/**
 * The thread a bsky.app post URL names, as one HTML document of its author's
 * posts. Null when the URL isn't a post, the appview can't serve it, or the
 * author asked not to be shown to signed-out readers.
 */
export async function bskyThreadHtml(rawUrl: string, get: GetText): Promise<SiteDocument | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const uri = bskyPostUri(url);
  if (!uri) return null;

  const started = Date.now();
  const anchor = await getThread(get, threadUrl(uri, DEPTH, PARENT_HEIGHT));
  if (!isPost(anchor)) return null;
  if (hidden(anchor.post.author)) return null;

  const run = threadRun(anchor);
  const posts = run.posts;
  let last = run.last;
  // The run reached the bottom of what one request returns and the author may
  // have gone on: continue from the last post read.
  for (
    let i = 0;
    i < MAX_CONTINUATIONS &&
    !last.replies &&
    (last.post.replyCount ?? 0) > 0 &&
    Date.now() - started < CONTINUE_WITHIN_MS;
    i++
  ) {
    // A continuation that fails keeps what was already read.
    const next = await getThread(get, threadUrl(last.post.uri, DEPTH, 0)).catch(() => null);
    if (!isPost(next)) break;
    const more = threadRun(next);
    posts.push(...more.posts.slice(1));
    last = more.last;
  }
  return threadHtml(posts, run.replyingTo);
}
