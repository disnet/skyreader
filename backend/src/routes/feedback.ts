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

/** Normalized, bare-path edge-cache key — one cached board for every caller. */
function boardCacheKey(request: Request): Request {
  return new Request(new URL('/api/v2/feedback', request.url).toString());
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
      const response = json({ error: 'Failed to load feedback' }, 502);
      response.headers.set('Cache-Control', 'public, max-age=30');
      return response;
    }
    return new Response(cached.body, cached);
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
      // The board's own vocabulary, so the page groups and files posts under the
      // same types userinput.app shows. Free with the board fetch.
      types: spaceTypes(record(record(payload.board).value)),
      posts,
    });
    response.headers.set('Cache-Control', 'public, max-age=300');
    try {
      await cache.put(cacheKey, response.clone());
    } catch (error) {
      log.error('feedback_board_cache_put_failed', serializeError(error));
    }
    return response;
  } catch (error) {
    log.error('feedback_board_failed', serializeError(error));
    reportMessage('userinput.app feedback board unavailable', {
      level: 'error',
      fingerprint: ['feedback-board-unavailable'],
      tags: { route: 'feedback' },
      extra: serializeError(error),
    });
    const response = json({ error: 'Failed to load feedback' }, 502);
    response.headers.set('Cache-Control', 'public, max-age=30');
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

  let body: { title?: unknown; body?: unknown; tags?: unknown };
  try {
    body = (await request.json()) as typeof body;
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
  const allowed = new Set(space.types.map((type) => type.value));
  const unknown = requestedTags.filter((tag) => !allowed.has(tag));
  if (unknown.length > 0) {
    return json({ error: `unknown tag: ${unknown[0]}` }, 400);
  }

  const rkey = generateTid();
  const createdAt = new Date().toISOString();
  const pdsClient = createPDSClient(session);
  const result = await pdsClient.putRecord(DISCUSSION_COLLECTION, rkey, {
    $type: DISCUSSION_COLLECTION,
    space: { uri: space.uri, cid: space.cid },
    title,
    ...(text ? { body: text } : {}),
    ...(requestedTags.length > 0 ? { tags: requestedTags } : {}),
    createdAt,
  });
  if (!result.success) {
    log.error('feedback_post_failed', { error: result.error });
    return json({ error: 'Failed to post feedback', message: result.error }, 502);
  }

  // Match userinput.app's composer: it upvotes the post it just created, keyed by
  // the discussion's own rkey. Best effort — a missing vote scope, or a PDS that
  // refuses the second write, must not turn a landed post into a failure.
  if (hasIntegrationScopes(session, 'userinput-votes')) {
    const vote = await pdsClient.putRecord(UPVOTE_COLLECTION, rkey, {
      $type: UPVOTE_COLLECTION,
      subject: { uri: result.data.uri, cid: result.data.cid },
      createdAt,
    });
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
    },
    201
  );
}
