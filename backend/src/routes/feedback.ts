import type { Env, Session } from '../types';
import { reportMessage } from '../observability/sentry';
import { createPDSClient } from '../services/pds-client';
import { resolvePdsUrl } from '../utils/did-resolver';
import { generateTid } from '../utils/tid';
import { log, serializeError } from '../utils/logger';
import { hasIntegrationScopes } from './integrations';

const PROFILE_BATCH_SIZE = 25;
const DISCUSSION_COLLECTION = 'app.userinput.discussion';
const UPVOTE_COLLECTION = 'app.userinput.upvote';
const SPACE_COLLECTION = 'app.userinput.space';
const USER_AGENT = 'Skyreader/1.0 feedback-board';
const TITLE_MAX = 300;
const BODY_MAX = 10000;
const MAX_TAGS = 2;
// The discussion lexicon's own limits for `images`: at most four attachments,
// each a blob of one of these types and at most a megabyte. Enforced here so a
// too-large upload is refused before it reaches the reader's repo, rather than
// by the PDS after the bytes have crossed the wire twice.
const MAX_IMAGES = 4;
const IMAGE_MAX_BYTES = 1_000_000;
const IMAGE_ALT_MAX = 2000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * The types a post can be filed under when the board owner hasn't configured any
 * on the space record itself. userinput.app treats a space's `tags` as the
 * board's own vocabulary (value + display label); these three are the values its
 * own composer hint suggests, and they are what the reader picks from here.
 */
const DEFAULT_TYPES = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature request' },
  { value: 'question', label: 'Question' },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : {};
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A space's configured post types, as `{ value, label }`. userinput.app lets a
 * board owner author these on the space record; a board that hasn't gets our
 * default vocabulary, so the composer always has something to file under.
 */
function spaceTypes(spaceValue: UnknownRecord): { value: string; label: string }[] {
  const configured = Array.isArray(spaceValue.tags)
    ? spaceValue.tags
        .map(record)
        .map((tag) => ({ value: string(tag.value), label: string(tag.label) || string(tag.value) }))
        .filter((tag) => tag.value)
    : [];
  return configured.length > 0 ? configured : DEFAULT_TYPES;
}

/**
 * The vocabulary to publish on the board response: the same entry a POST
 * validates against, falling back to the copy the board fetch already carried.
 *
 * The fallback is what keeps a healthy board readable while the owner's PDS is
 * not — reading the board needs no space record at all, and only posting does.
 */
async function spaceTypesForBoard(
  request: Request,
  env: Env,
  boardSpaceValue: UnknownRecord
): Promise<{ value: string; label: string }[]> {
  try {
    return (await loadSpace(request, env)).types;
  } catch (error) {
    log.warn('feedback_space_types_fallback', serializeError(error));
    return spaceTypes(boardSpaceValue);
  }
}

/** Normalized, bare-path edge-cache key — one cached board for every caller. */
function boardCacheKey(request: Request): Request {
  return new Request(new URL('/api/v2/feedback', request.url).toString());
}

/**
 * The board as the browser should receive it: never from its own HTTP cache.
 *
 * The five-minute cache below is the *edge's* — one upstream fetch serving
 * everyone. A browser keeping its own copy for those same five minutes is a
 * different thing entirely: posting busts the edge entry, and the reader still
 * reloads straight into a list that cannot contain what they just wrote.
 */
function noBrowserCache(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set('Cache-Control', 'no-store');
  return copy;
}

async function loadProfiles(dids: string[]): Promise<Map<string, UnknownRecord>> {
  const profiles = new Map<string, UnknownRecord>();
  for (let offset = 0; offset < dids.length; offset += PROFILE_BATCH_SIZE) {
    const batch = dids.slice(offset, offset + PROFILE_BATCH_SIZE);
    try {
      const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles');
      for (const did of batch) url.searchParams.append('actors', did);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Skyreader/1.0 feedback-board' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Profile service returned ${response.status}`);
      const payload = record(JSON.parse(await response.text()));
      if (!Array.isArray(payload.profiles)) throw new Error('Profile response is malformed');
      for (const value of payload.profiles) {
        const profile = record(value);
        const did = string(profile.did);
        if (did) profiles.set(did, profile);
      }
    } catch (error) {
      // Profiles are decoration, not a reason to hide an otherwise healthy board.
      log.warn('feedback_profiles_failed', serializeError(error));
    }
  }
  return profiles;
}

export async function handleGetFeedback(
  request: Request,
  env: Env,
  _session: Session | null
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!env.USERINPUT_SPACE_DID || !env.USERINPUT_SPACE_RKEY) {
    return json({ error: 'Feedback is not configured' }, 503);
  }

  const cache = caches.default;
  const cacheKey = boardCacheKey(request);
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) {
    const cachedStatus = cached.headers.get('X-Skyreader-Cached-Status');
    if (cachedStatus === '502') {
      return noBrowserCache(json({ error: 'Failed to load feedback' }, 502));
    }
    return noBrowserCache(cached);
  }

  const apiBase = env.USERINPUT_API_URL || 'https://userinput.app';
  try {
    const boardUrl = new URL(
      `/api/board/${env.USERINPUT_SPACE_DID}/${env.USERINPUT_SPACE_RKEY}`,
      apiBase
    );
    const upstream = await fetch(boardUrl, {
      headers: { 'User-Agent': 'Skyreader/1.0 feedback-board' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await upstream.text();
    if (!upstream.ok) throw new Error(`userinput.app returned ${upstream.status}: ${text}`);
    const payload = record(JSON.parse(text));
    if (!Array.isArray(payload.posts)) throw new Error('userinput.app board response is malformed');

    const visible = payload.posts.map(record).filter((post) => !post.hidden && !post.banned);
    const dids = [...new Set(visible.map((post) => string(post.authorDid)).filter(Boolean))];
    const profiles = await loadProfiles(dids);
    const posts = visible
      .map((post) => {
        const value = record(post.value);
        const votes = record(post.votes);
        const status = record(post.status);
        const did = string(post.authorDid);
        const profile = profiles.get(did) ?? {};
        const uri = string(post.uri);
        const rkey = uri.split('/').at(-1) ?? '';
        return {
          uri,
          url: `${apiBase.replace(/\/$/, '')}/d/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`,
          author: {
            did,
            handle: string(profile.handle) || did,
            displayName: string(profile.displayName) || null,
            avatar: string(profile.avatar) || null,
          },
          title: string(value.title),
          body: string(value.body),
          tags: Array.isArray(value.tags)
            ? value.tags.filter((tag): tag is string => typeof tag === 'string')
            : [],
          createdAt: string(value.createdAt),
          votes: { up: number(votes.up), down: number(votes.down), net: number(votes.net) },
          replyCount: number(post.replyCount),
          status: string(status.state) || null,
        };
      })
      .sort(
        (a, b) => b.votes.net - a.votes.net || Date.parse(b.createdAt) - Date.parse(a.createdAt)
      );

    const response = json({
      spaceUrl: `${apiBase.replace(/\/$/, '')}/s/${encodeURIComponent(env.USERINPUT_SPACE_DID)}/${encodeURIComponent(env.USERINPUT_SPACE_RKEY)}`,
      total: posts.length,
      complete: payload.complete === true,
      // The board's own vocabulary, so the page files posts under the same types
      // userinput.app shows. Read through loadSpace rather than off the board
      // payload that came free with this fetch, even though both hold the same
      // record: loadSpace is what a POST validates against, and two views of the
      // vocabulary on different cache clocks means a composer that can offer a
      // type the write then refuses. Sharing the entry makes a vocabulary edit
      // arrive late here instead, which costs a reader nothing.
      types: await spaceTypesForBoard(request, env, record(record(payload.board).value)),
      posts,
    });
    response.headers.set('Cache-Control', 'public, max-age=300');
    try {
      await cache.put(cacheKey, response.clone());
    } catch (error) {
      log.error('feedback_board_cache_put_failed', serializeError(error));
    }
    return noBrowserCache(response);
  } catch (error) {
    log.error('feedback_board_failed', serializeError(error));
    reportMessage('userinput.app feedback board unavailable', {
      level: 'error',
      fingerprint: ['feedback-board-unavailable'],
      tags: { route: 'feedback' },
      extra: serializeError(error),
    });
    const response = noBrowserCache(json({ error: 'Failed to load feedback' }, 502));
    try {
      // Workers Cache does not retain non-2xx responses. Store a private
      // success envelope and reconstruct the public 502 on a cache hit.
      const cachedFailure = json({ error: 'Failed to load feedback' });
      cachedFailure.headers.set('Cache-Control', 'public, max-age=30');
      cachedFailure.headers.set('X-Skyreader-Cached-Status', '502');
      await cache.put(cacheKey, cachedFailure);
    } catch (cacheError) {
      log.error('feedback_board_cache_put_failed', serializeError(cacheError));
    }
    return response;
  }
}

/**
 * GET /api/v2/feedback/mine — the caller's own posts, reduced to what changes.
 *
 * The client polls this to notice a status change or a new reply on something
 * it filed. It is the board's own read, filtered to one author: served off the
 * same edge-cached fetch, so a poll costs upstream nothing, and answered with
 * the four fields a diff needs rather than the whole board, so it costs the
 * reader nothing either.
 */
export async function handleGetMyFeedback(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const board = await handleGetFeedback(
    new Request(new URL('/api/v2/feedback', request.url).toString()),
    env,
    null
  );
  if (!board.ok) return noBrowserCache(json({ error: 'Failed to load feedback' }, board.status));

  const payload = record(await board.json().catch(() => null));
  const posts = Array.isArray(payload.posts) ? payload.posts.map(record) : [];
  return noBrowserCache(
    json({
      posts: posts
        .filter((post) => string(record(post.author).did) === session.did)
        .map((post) => ({
          uri: string(post.uri),
          url: string(post.url),
          title: string(post.title),
          status: post.status === null ? null : string(post.status) || null,
          replyCount: number(post.replyCount),
        })),
    })
  );
}

// A post's own address, as it goes into an upstream path. Both are validated
// rather than passed through: they are caller-supplied and land in a URL we
// fetch, so anything outside atproto's own grammar is refused here.
// `.` and `..` are excluded from the rkey the way atproto's own syntax excludes
// them: everything else here is a path segment that can't traverse, and those
// two are the pair that can.
const DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]{1,300}$/;
const RKEY_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._~:-]{1,512}$/;

/**
 * GET /api/v2/feedback/thread?did=…&rkey=… — the replies on one post.
 *
 * Public, like the board: a reply is a record in its author's repo, aggregated
 * by backlinks the same way, and reading them needs nobody's session. Fetched
 * on demand rather than with the board, because the board is one request for
 * every post and a thread is one request for each — nobody expands them all.
 */
export async function handleGetFeedbackThread(
  request: Request,
  env: Env,
  _session: Session | null
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const params = new URL(request.url).searchParams;
  const did = params.get('did') ?? '';
  const rkey = params.get('rkey') ?? '';
  if (!DID_PATTERN.test(did) || !RKEY_PATTERN.test(rkey)) {
    return json({ error: 'did and rkey are required' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(
    new URL(
      `/api/v2/feedback/thread?did=${encodeURIComponent(did)}&rkey=${encodeURIComponent(rkey)}`,
      request.url
    ).toString()
  );
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) return noBrowserCache(cached);

  const apiBase = env.USERINPUT_API_URL || 'https://userinput.app';
  try {
    // Interpolated raw, like the board call above: userinput.app matches the
    // literal DID in the path and 404s on a percent-encoded one. Safe because
    // both halves are checked against the grammar above first.
    const threadUrl = new URL(`/api/thread/${did}/${rkey}`, apiBase);
    const upstream = await fetch(threadUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    const text = await upstream.text();
    if (!upstream.ok) throw new Error(`userinput.app returned ${upstream.status}: ${text}`);
    const payload = record(JSON.parse(text));
    if (!Array.isArray(payload.replies)) {
      throw new Error('userinput.app thread response is malformed');
    }

    const visible = payload.replies.map(record).filter((reply) => !reply.hidden && !reply.banned);
    const profiles = await loadProfiles([
      ...new Set(visible.map((reply) => string(reply.authorDid)).filter(Boolean)),
    ]);
    // Whoever moderates the space — the maintainer, in practice. A reply from
    // them is the answer a reader is looking for, so it says so on the row.
    const mods = new Set(
      Array.isArray(payload.modDids) ? payload.modDids.map(string).filter(Boolean) : []
    );
    const replies = visible
      .map((reply) => {
        const value = record(reply.value);
        const votes = record(reply.votes);
        const authorDid = string(reply.authorDid);
        const profile = profiles.get(authorDid) ?? {};
        return {
          uri: string(reply.uri),
          // Null for a reply to the post itself; set for a reply to a reply,
          // which the page indents rather than flattening into the same column.
          parentUri: string(reply.parentUri) || null,
          author: {
            did: authorDid,
            handle: string(profile.handle) || authorDid,
            displayName: string(profile.displayName) || null,
            avatar: string(profile.avatar) || null,
            mod: mods.has(authorDid),
          },
          body: string(value.body),
          createdAt: string(value.createdAt),
          editedAt: string(reply.editedAt) || null,
          votes: { up: number(votes.up), down: number(votes.down), net: number(votes.net) },
        };
      })
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    const response = json({ total: replies.length, complete: payload.complete === true, replies });
    // Shorter than the board's five minutes: a reader expands a thread because
    // they want to know whether anyone answered, which is exactly the thing that
    // changes under a long cache.
    response.headers.set('Cache-Control', 'public, max-age=60');
    try {
      await cache.put(cacheKey, response.clone());
    } catch (error) {
      log.error('feedback_thread_cache_put_failed', serializeError(error));
    }
    return noBrowserCache(response);
  } catch (error) {
    // One thread failing is one row that can't expand, not an outage — logged,
    // but deliberately not reported the way an unreachable board is.
    log.error('feedback_thread_failed', { did, rkey, ...serializeError(error) });
    return noBrowserCache(json({ error: 'Failed to load replies' }, 502));
  }
}

interface FeedbackSpace {
  uri: string;
  cid: string;
  types: { value: string; label: string }[];
}

/**
 * The space record a new post points at, read straight from the owner's PDS.
 *
 * A discussion carries a strong ref (`{uri, cid}`) to its space, so posting needs
 * the space's *current* cid — the board API's snapshot would do, but that call is
 * the slow, undocumented one, and this is public `getRecord` against the owner's
 * PDS. Cached for an hour: a board's identity changes about never.
 */
async function loadSpace(request: Request, env: Env): Promise<FeedbackSpace> {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/v2/feedback/space', request.url).toString());
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) {
    const entry = record(await cached.json().catch(() => null));
    if (string(entry.uri) && string(entry.cid)) {
      return {
        uri: string(entry.uri),
        cid: string(entry.cid),
        types: Array.isArray(entry.types)
          ? entry.types.map(record).map((type) => ({
              value: string(type.value),
              label: string(type.label),
            }))
          : DEFAULT_TYPES,
      };
    }
  }

  const pdsUrl = await resolvePdsUrl(env.USERINPUT_SPACE_DID);
  if (!pdsUrl) throw new Error(`Could not resolve a PDS for ${env.USERINPUT_SPACE_DID}`);
  const url = new URL('/xrpc/com.atproto.repo.getRecord', pdsUrl);
  url.searchParams.set('repo', env.USERINPUT_SPACE_DID);
  url.searchParams.set('collection', SPACE_COLLECTION);
  url.searchParams.set('rkey', env.USERINPUT_SPACE_RKEY);
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Space lookup returned ${response.status}: ${text}`);
  const payload = record(JSON.parse(text));
  const space: FeedbackSpace = {
    uri: string(payload.uri),
    cid: string(payload.cid),
    types: spaceTypes(record(payload.value)),
  };
  if (!space.uri || !space.cid) throw new Error('Space record is malformed');

  try {
    const entry = json(space);
    entry.headers.set('Cache-Control', 'public, max-age=3600');
    await cache.put(cacheKey, entry);
  } catch (error) {
    log.error('feedback_space_cache_put_failed', serializeError(error));
  }
  return space;
}

/** The `images` entry a post carries, or null when the client sent nonsense. */
function imageEntry(value: unknown): { alt: string; image: UnknownRecord } | null {
  const entry = record(value);
  const blob = record(entry.image);
  const ref = record(blob.ref);
  if (blob.$type !== 'blob' || !string(ref.$link)) return null;
  if (!IMAGE_TYPES.has(string(blob.mimeType))) return null;
  if (number(blob.size) <= 0 || number(blob.size) > IMAGE_MAX_BYTES) return null;
  return { alt: string(entry.alt).slice(0, IMAGE_ALT_MAX), image: blob };
}

/**
 * The whole body, or null if it runs past `limit`.
 *
 * Read a chunk at a time rather than through `request.arrayBuffer()`, which
 * materializes whatever was sent before anything can look at its size: a 1 MB
 * rule enforced after the fact still lets a signed-in caller make a 128 MB
 * isolate hold a hundred megabytes, twenty times a minute. Content-Length is
 * checked before this, but it is the caller's claim about the body, not a bound
 * on it, and a chunked body carries none at all.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<ArrayBuffer | null> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Stop pulling: the rest of the upload is never read, so it is never held.
      if (total > limit) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new ArrayBuffer(total);
  const view = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * POST /api/v2/feedback/image — upload one attachment to the reader's own blob
 * store and hand back the reference their post will embed.
 *
 * Separate from the post itself because that is how atproto works: bytes go up
 * first, and the record that references them is written afterwards. It also
 * means the composer can validate and show a thumbnail while the reader is
 * still typing, and an abandoned draft leaves only unreferenced blobs, which a
 * PDS collects on its own.
 */
export async function handleUploadFeedbackImage(
  request: Request,
  _env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!hasIntegrationScopes(session, 'userinput-images')) {
    return json(
      {
        error: 'scope_upgrade_required',
        message: 'Attaching an image needs a new permission. Please log in again.',
        integration: 'userinput',
      },
      403
    );
  }

  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!IMAGE_TYPES.has(contentType)) {
    return json({ error: 'Unsupported image type', message: `${contentType || 'none'}` }, 415);
  }

  // Answered before a byte is read when the caller declares an over-size body.
  // Absent or understated, the capped read below is what actually holds.
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) {
    return json({ error: 'Image is over 1 MB' }, 413);
  }

  const bytes = await readCapped(request.body, IMAGE_MAX_BYTES);
  if (bytes === null) return json({ error: 'Image is over 1 MB' }, 413);
  if (bytes.byteLength === 0) return json({ error: 'Empty image' }, 400);

  const result = await createPDSClient(session).uploadBlob(bytes, contentType);
  if (!result.success) {
    log.error('feedback_image_upload_failed', { error: result.error });
    return json({ error: 'Failed to upload image', message: result.error }, 502);
  }
  return json({ blob: result.data.blob }, 201);
}

/**
 * POST /api/v2/feedback — file a post on the board without leaving Skyreader.
 *
 * userinput.app has no backend of its own: a post is an `app.userinput.discussion`
 * record in the *author's* repo, aggregated by backlinks. So this writes to the
 * reader's PDS with their own session — the post is theirs, publicly, exactly as
 * if they had written it on userinput.app.
 */
export async function handleCreateFeedback(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (!env.USERINPUT_SPACE_DID || !env.USERINPUT_SPACE_RKEY) {
    return json({ error: 'Feedback is not configured' }, 503);
  }
  if (!hasIntegrationScopes(session, 'userinput')) {
    return json(
      {
        error: 'scope_upgrade_required',
        message: 'Posting feedback needs a new permission. Please log in again.',
        integration: 'userinput',
      },
      403
    );
  }

  // `request.json()` happily returns `null`, a string or an array — all valid
  // JSON, none of them a post. Normalize through `record()` so a malformed body
  // reads as an empty one and falls out as a 400 rather than a thrown field read.
  let body: UnknownRecord;
  try {
    body = record(await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const title = string(body.title).trim();
  const text = string(body.body).trim();
  if (!title) return json({ error: 'title is required' }, 400);
  if (title.length > TITLE_MAX)
    return json({ error: `title is over ${TITLE_MAX} characters` }, 400);
  if (text.length > BODY_MAX) return json({ error: `body is over ${BODY_MAX} characters` }, 400);

  const requestedTags = Array.isArray(body.tags)
    ? [...new Set(body.tags.map((tag) => string(tag).trim().toLowerCase()).filter(Boolean))]
    : [];
  if (requestedTags.length > MAX_TAGS) {
    return json({ error: `at most ${MAX_TAGS} tags` }, 400);
  }

  // Attachments arrive as the blob references /api/v2/feedback/image handed back.
  // They are re-validated rather than trusted: the reference names its own size
  // and type, and it is the record — not the upload — that publishes them.
  const requestedImages = Array.isArray(body.images) ? body.images : [];
  if (requestedImages.length > MAX_IMAGES) {
    return json({ error: `at most ${MAX_IMAGES} images` }, 400);
  }
  const images = requestedImages.map(imageEntry);
  if (images.some((image) => image === null)) {
    return json({ error: 'malformed image attachment' }, 400);
  }

  let space: FeedbackSpace;
  try {
    space = await loadSpace(request, env);
  } catch (error) {
    log.error('feedback_space_failed', serializeError(error));
    reportMessage('userinput.app space record unavailable', {
      level: 'error',
      fingerprint: ['feedback-space-unavailable'],
      tags: { route: 'feedback' },
      extra: serializeError(error),
    });
    return json({ error: 'Failed to reach the feedback board' }, 502);
  }

  // Only the board's own vocabulary is written. An unknown tag would render as a
  // raw slug on userinput.app and put a type on the board nobody can file under.
  //
  // Matched case-insensitively and written back in the board's own casing: the
  // request was already folded to lower case (to dedupe), but the vocabulary is
  // upstream's data and nothing says a space tag is lower case. Comparing the
  // two directly would reject every post to a board that configured `Bug`,
  // including the value its own composer just offered.
  const allowed = new Map(space.types.map((type) => [type.value.toLowerCase(), type.value]));
  const unknown = requestedTags.filter((tag) => !allowed.has(tag));
  if (unknown.length > 0) {
    return json({ error: `unknown tag: ${unknown[0]}` }, 400);
  }
  const tags = requestedTags.map((tag) => allowed.get(tag) as string);

  const rkey = generateTid();
  const createdAt = new Date().toISOString();
  const pdsClient = createPDSClient(session);
  const result = await pdsClient.putRecord(DISCUSSION_COLLECTION, rkey, {
    $type: DISCUSSION_COLLECTION,
    space: { uri: space.uri, cid: space.cid },
    title,
    ...(text ? { body: text } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(images.length > 0
      ? {
          images: images.map((image) => ({
            ...(image!.alt ? { alt: image!.alt } : {}),
            image: image!.image,
          })),
        }
      : {}),
    createdAt,
  });
  if (!result.success) {
    log.error('feedback_post_failed', { error: result.error });
    return json({ error: 'Failed to post feedback', message: result.error }, 502);
  }

  // Match userinput.app's composer: it upvotes the post it just created, keyed by
  // the discussion's own rkey. Best effort — a missing vote scope, or a PDS that
  // refuses the second write, must not turn a landed post into a failure.
  let upvoted = false;
  if (hasIntegrationScopes(session, 'userinput-votes')) {
    const vote = await pdsClient.putRecord(UPVOTE_COLLECTION, rkey, {
      $type: UPVOTE_COLLECTION,
      subject: { uri: result.data.uri, cid: result.data.cid },
      createdAt,
    });
    upvoted = vote.success;
    if (!vote.success) log.warn('feedback_self_upvote_failed', { error: vote.error });
  }

  // Drop the cached board so the reader isn't looking at a five-minute-old list
  // that can't contain what they just wrote. (Upstream indexes by backlink, so
  // the post still takes a moment to appear for everyone — the page says so.)
  try {
    await caches.default.delete(boardCacheKey(request));
  } catch (error) {
    log.warn('feedback_board_cache_delete_failed', serializeError(error));
  }

  const apiBase = (env.USERINPUT_API_URL || 'https://userinput.app').replace(/\/$/, '');
  return json(
    {
      uri: result.data.uri,
      cid: result.data.cid,
      url: `${apiBase}/d/${encodeURIComponent(session.did)}/${encodeURIComponent(rkey)}`,
      createdAt,
      // Whether the self-upvote actually landed, so the page's optimistic row
      // shows the vote count the board will have rather than assuming one.
      upvoted,
    },
    201
  );
}
