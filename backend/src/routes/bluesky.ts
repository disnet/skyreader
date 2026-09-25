// Also posting a linkblog share to Bluesky.
//
// A cross-post is an app.bsky.feed.post in the reader's own repo, written with
// their own session: the post is theirs, exactly as if they had written it in a
// Bluesky client. It carries either the article's link card or, when the share
// quotes the article, those passages as images ("text shots") with the link in
// the text — Bluesky can't embed both at once.
//
// Two steps, the way atproto works: images go up first (POST /api/v2/bluesky/image,
// rendered in the browser), then the post that references them. An abandoned
// upload leaves an unreferenced blob, which the PDS collects on its own.

import type { Env, Session } from '../types';
import { createPDSClient, type BlobRef } from '../services/pds-client';
import { resolveHandle } from '../services/oauth';
import { parseHandleTokens } from '../utils/mention-facets';
import { generateTid } from '../utils/tid';
import { log } from '../utils/logger';
import { hasIntegrationScopes } from './integrations';
import { readCapped } from './feedback';

export const POST_COLLECTION = 'app.bsky.feed.post';

// Bluesky's own limits (app.bsky.feed.post, app.bsky.embed.*).
export const TEXT_MAX_GRAPHEMES = 300;
const TEXT_MAX_BYTES = 3000;
const MAX_IMAGES = 4;
const IMAGE_MAX_BYTES = 1_000_000;
const IMAGE_ALT_MAX = 2000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const EXTERNAL_TITLE_MAX = 300;
const EXTERNAL_DESCRIPTION_MAX = 1000;
const MAX_RESOLVED_HANDLES = 10;
const MAX_LANGS = 3;
// A BCP-47 tag's shape (en, pt-BR, zh-Hant-TW), enough to keep junk out of the record.
const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8}){0,3}$/;
const THUMB_TIMEOUT_MS = 5000;
const USER_AGENT = 'Skyreader/1.0 (+https://skyreader.app)';

const encoder = new TextEncoder();

type UnknownRecord = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function scopeUpgrade(message: string): Response {
  return json({ error: 'scope_upgrade_required', message, feature: 'blueskyPost' }, 403);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Grapheme count, the unit Bluesky's 300-character limit is measured in. */
export function graphemeLength(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let count = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      count++;
    }
    return count;
  }
  return [...text].length;
}

function byteLen(text: string): number {
  return encoder.encode(text).length;
}

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; did?: string }>;
}

// Bare URLs a reader typed into their commentary. Trailing punctuation is left
// out of the link, the way Bluesky's own composer does it.
const URL_RE = /(^|[\s(])(https?:\/\/[^\s]+)/g;

/**
 * Link facets for `text`: the article's link (displayed shortened, at
 * `linkText`) plus any full URLs in the commentary. Byte-indexed (UTF-8), the
 * atproto facet convention.
 */
export function linkFacets(text: string, articleUrl: string, linkText?: string): Facet[] {
  const facets: Facet[] = [];
  let articleStart = -1;
  if (linkText) {
    articleStart = text.lastIndexOf(linkText);
    if (articleStart >= 0) {
      const byteStart = byteLen(text.slice(0, articleStart));
      facets.push({
        index: { byteStart, byteEnd: byteStart + byteLen(linkText) },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: articleUrl }],
      });
    }
  }
  for (const m of text.matchAll(URL_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    // The article link's own span is already covered above.
    if (articleStart >= 0 && start >= articleStart && start < articleStart + linkText!.length) {
      continue;
    }
    const uri = m[2].replace(/[.,;:!?'")\]…]+$/, '');
    if (!isHttpUrl(uri)) continue;
    const byteStart = byteLen(text.slice(0, start));
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLen(uri) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }
  return facets;
}

/** Mention facets for every `@handle` in `text` that resolves to a DID. */
async function mentionFacets(text: string): Promise<Facet[]> {
  const tokens = parseHandleTokens(text);
  if (tokens.length === 0) return [];
  const handles = [...new Set(tokens.map((t) => t.handle.toLowerCase()))].slice(
    0,
    MAX_RESOLVED_HANDLES
  );
  const dids = new Map<string, string>();
  await Promise.all(
    handles.map(async (handle) => {
      try {
        const did = await resolveHandle(handle);
        if (did?.startsWith('did:')) dids.set(handle, did);
      } catch {
        // An unresolvable handle stays plain text.
      }
    })
  );
  return tokens.flatMap((token) => {
    const did = dids.get(token.handle.toLowerCase());
    if (!did) return [];
    return [
      {
        index: { byteStart: token.byteStart, byteEnd: token.byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
      },
    ];
  });
}

interface PostImage {
  image: BlobRef;
  alt: string;
  aspectRatio?: { width: number; height: number };
}

/** One attachment as the client sent it, re-validated: the blob names its own size and type. */
function imageEntry(value: unknown): PostImage | null {
  const entry = record(value);
  const blob = record(entry.image);
  const ref = record(blob.ref);
  if (blob.$type !== 'blob' || !string(ref.$link)) return null;
  if (!IMAGE_TYPES.has(string(blob.mimeType))) return null;
  if (number(blob.size) <= 0 || number(blob.size) > IMAGE_MAX_BYTES) return null;
  const ratio = record(entry.aspectRatio);
  const width = Math.round(number(ratio.width));
  const height = Math.round(number(ratio.height));
  return {
    image: blob as unknown as BlobRef,
    alt: string(entry.alt).slice(0, IMAGE_ALT_MAX),
    ...(width > 0 && height > 0 ? { aspectRatio: { width, height } } : {}),
  };
}

/**
 * The article's lead image, uploaded as the link card's thumbnail. Best-effort:
 * a card without a picture is still a card, so any failure here is a null.
 */
async function uploadThumb(session: Session, imageUrl: string): Promise<BlobRef | null> {
  if (!isHttpUrl(imageUrl)) return null;
  try {
    const response = await fetch(imageUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      signal: AbortSignal.timeout(THUMB_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim();
    if (!IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await readCapped(response.body, IMAGE_MAX_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;
    const result = await createPDSClient(session).uploadBlob(bytes, contentType);
    return result.success ? result.data.blob : null;
  } catch {
    return null;
  }
}

/** The post's languages, as the client named them: well-formed tags only, deduplicated. */
export function postLangs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const langs = value.filter((v): v is string => typeof v === 'string' && LANG_RE.test(v));
  return [...new Set(langs)].slice(0, MAX_LANGS);
}

/** https://bsky.app link for a post's at:// URI. */
export function bskyPostUrl(uri: string): string {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  return match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : 'https://bsky.app';
}

/**
 * POST /api/v2/bluesky/image — upload one text shot to the reader's blob store
 * and hand back the reference the post will embed. Raw bytes under the image's
 * own content type (uploadBlob's shape, not a multipart form).
 */
export async function handleUploadBlueskyImage(
  request: Request,
  _env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!hasIntegrationScopes(session, 'blueskyPost')) {
    return scopeUpgrade('Posting to Bluesky needs a new permission.');
  }

  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!IMAGE_TYPES.has(contentType)) {
    return json({ error: 'Unsupported image type', message: contentType || 'none' }, 415);
  }
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) {
    return json({ error: 'Image is over 1 MB' }, 413);
  }
  const bytes = await readCapped(request.body, IMAGE_MAX_BYTES);
  if (bytes === null) return json({ error: 'Image is over 1 MB' }, 413);
  if (bytes.byteLength === 0) return json({ error: 'Empty image' }, 400);

  const result = await createPDSClient(session).uploadBlob(bytes, contentType);
  if (!result.success) {
    if (/scope/i.test(result.error))
      return scopeUpgrade('Posting to Bluesky needs a new permission.');
    log.error('bluesky_image_upload_failed', { error: result.error });
    return json({ error: 'Failed to upload image', message: result.error }, 502);
  }
  return json({ blob: result.data.blob }, 201);
}

/**
 * POST /api/v2/bluesky/post — write the cross-post.
 *
 * Body: { text, articleUrl, linkText?, title?, description?, imageUrl?, images?, langs? }.
 * With `images` the post embeds them and the article link lives in the text
 * (`linkText` marks where); without, it embeds the article's link card.
 */
export async function handleCreateBlueskyPost(
  request: Request,
  _env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!hasIntegrationScopes(session, 'blueskyPost')) {
    return scopeUpgrade('Posting to Bluesky needs a new permission.');
  }

  let body: UnknownRecord;
  try {
    body = record(await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const text = string(body.text).trim();
  const articleUrl = string(body.articleUrl);
  const linkText = string(body.linkText) || undefined;
  if (!isHttpUrl(articleUrl)) return json({ error: 'articleUrl must be a valid http(s) URL' }, 400);
  if (graphemeLength(text) > TEXT_MAX_GRAPHEMES || byteLen(text) > TEXT_MAX_BYTES) {
    return json({ error: `text is over ${TEXT_MAX_GRAPHEMES} characters` }, 400);
  }

  const requestedImages = Array.isArray(body.images) ? body.images : [];
  if (requestedImages.length > MAX_IMAGES) {
    return json({ error: `at most ${MAX_IMAGES} images` }, 400);
  }
  const images = requestedImages.map(imageEntry);
  if (images.some((image) => image === null)) {
    return json({ error: 'malformed image attachment' }, 400);
  }
  // With the card gone, the text is the only way to reach the article.
  if (images.length > 0 && (!linkText || !text.includes(linkText))) {
    return json({ error: 'a post with images must link the article in its text' }, 400);
  }

  const facets = [...linkFacets(text, articleUrl, linkText), ...(await mentionFacets(text))].sort(
    (a, b) => a.index.byteStart - b.index.byteStart
  );

  let embed: UnknownRecord;
  if (images.length > 0) {
    embed = { $type: 'app.bsky.embed.images', images };
  } else {
    const thumb = await uploadThumb(session, string(body.imageUrl));
    embed = {
      $type: 'app.bsky.embed.external',
      external: {
        uri: articleUrl,
        title: string(body.title).slice(0, EXTERNAL_TITLE_MAX),
        description: string(body.description).slice(0, EXTERNAL_DESCRIPTION_MAX),
        ...(thumb ? { thumb } : {}),
      },
    };
  }

  const rkey = generateTid();
  const langs = postLangs(body.langs);
  const post: UnknownRecord = {
    $type: POST_COLLECTION,
    text,
    ...(facets.length > 0 ? { facets } : {}),
    embed,
    ...(langs.length > 0 ? { langs } : {}),
    createdAt: new Date().toISOString(),
  };

  const result = await createPDSClient(session).putRecord(POST_COLLECTION, rkey, post);
  if (!result.success) {
    if (/scope/i.test(result.error))
      return scopeUpgrade('Posting to Bluesky needs a new permission.');
    log.error('bluesky_post_failed', { error: result.error });
    return json({ error: 'Failed to post to Bluesky', message: result.error }, 502);
  }
  return json(
    { uri: result.data.uri, cid: result.data.cid, url: bskyPostUrl(result.data.uri) },
    201
  );
}
