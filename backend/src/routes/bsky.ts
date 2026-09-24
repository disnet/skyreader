// Bluesky feeds as sources (docs/plans/BLUESKY_FEEDS_PLAN.md): the Following
// timeline, or a feed the reader saved in Bluesky, as a source a channel can
// name, plus the small set of actions a reader takes on a post.
//
//   GET    /api/v2/bsky/feeds[?saved=1]   the reader's Bluesky sources, what they may
//                                         do, and (saved=1) the feeds saved in Bluesky
//   POST   /api/v2/bsky/feeds  { uri }     add one as a source
//   DELETE /api/v2/bsky/feeds  { uri }     remove it
//   GET    /api/v2/bsky/feed?uri=&cursor=  one page of a feed, read live (never stored)
//   POST   /api/v2/bsky/like    { uri, cid }  / DELETE { uri: likeUri }
//   POST   /api/v2/bsky/repost  { uri, cid }  / DELETE { uri: repostUri }
//   POST   /api/v2/bsky/post    { text, reply?: { root, parent } }
//
// Reads answer 200 { scopeRequired: true } without the permission, not a 403:
// a 403 scope_upgrade_required raises the app-wide "log in again" banner, and a
// channel's empty state is the place to ask. Writes do 403 (feature
// 'blueskyWrite'); the client asks inline before it ever sends one.

import type { Env, Session } from '../types';
import { createPDSClient } from '../services/pds-client';
import { BLUESKY_READ_SCOPES, BLUESKY_WRITE_SCOPES, FOLLOWS_LINKS_SCOPES } from '../config/scopes';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { fetchFeedGenerators } from '../services/bsky-appview';
import {
  POST_MAX_GRAPHEMES,
  detectFacets,
  graphemeLength,
  normalizeFeed,
  resolveMentions,
  type RawFeedItem,
} from '../services/bsky-posts';
import { resolveHandle } from '../services/oauth';
import { log } from '../utils/logger';

/** The Following timeline's feed "uri". */
export const FOLLOWING_FEED = 'following';

/** How many Bluesky feeds one reader can add as sources. */
export const MAX_BSKY_FEEDS = 50;

const FEED_PAGE_DEFAULT = 30;
const FEED_PAGE_MAX = 100;

/** Mentions resolved per post; more stay plain text. */
const MAX_MENTIONS = 10;

const GENERATOR_URI_RE =
  /^at:\/\/did:[a-z0-9]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.generator\/[a-zA-Z0-9._:~-]{1,512}$/;
const POST_URI_RE =
  /^at:\/\/did:[a-z0-9]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._:~-]{1,512}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function isFeedUri(uri: unknown): uri is string {
  return typeof uri === 'string' && (uri === FOLLOWING_FEED || GENERATOR_URI_RE.test(uri));
}

export interface BskyFeedSource {
  uri: string;
  displayName: string;
  description?: string;
  avatar?: string;
}

/** What the reader's session lets them do with Bluesky. */
function access(session: Session) {
  return {
    /** The Following timeline (also granted by From your follows). */
    timeline: hasRequiredScopes(session.grantedScopes, FOLLOWS_LINKS_SCOPES),
    /** Custom feeds and the saved-feed list. */
    feeds: hasRequiredScopes(session.grantedScopes, BLUESKY_READ_SCOPES),
    /** Like, repost and reply. */
    write: hasRequiredScopes(session.grantedScopes, BLUESKY_WRITE_SCOPES),
  };
}

/** Whether this session may read `uri`. */
function canRead(session: Session, uri: string): boolean {
  const a = access(session);
  return uri === FOLLOWING_FEED ? a.timeline : a.feeds;
}

async function listFeedSources(env: Env, did: string): Promise<BskyFeedSource[]> {
  const { results } = await env.DB.prepare(
    `SELECT feed_uri, display_name, description, avatar FROM bsky_feeds
     WHERE user_did = ? ORDER BY created_at ASC`
  )
    .bind(did)
    .all<{
      feed_uri: string;
      display_name: string;
      description: string | null;
      avatar: string | null;
    }>();
  return results.map((r) => ({
    uri: r.feed_uri,
    displayName: r.display_name,
    ...(r.description ? { description: r.description } : {}),
    ...(r.avatar ? { avatar: r.avatar } : {}),
  }));
}

interface SavedFeedsPrefV2 {
  $type: 'app.bsky.actor.defs#savedFeedsPrefV2';
  items?: { type?: string; value?: string; pinned?: boolean }[];
}

interface SavedFeedsPrefV1 {
  $type: 'app.bsky.actor.defs#savedFeedsPref';
  pinned?: string[];
  saved?: string[];
}

/**
 * The feeds the reader saved in Bluesky, pinned first, in their own order.
 * Lists and anything that isn't a feed generator (or the timeline) are left out.
 */
export function savedFeedUris(preferences: unknown[]): string[] {
  const seen = new Set<string>();
  const pinned: string[] = [];
  const rest: string[] = [];
  const add = (uri: string | undefined, isPinned: boolean) => {
    if (!uri || seen.has(uri)) return;
    seen.add(uri);
    (isPinned ? pinned : rest).push(uri);
  };

  const v2 = preferences.find(
    (p): p is SavedFeedsPrefV2 =>
      (p as { $type?: string })?.$type === 'app.bsky.actor.defs#savedFeedsPrefV2'
  );
  if (v2) {
    for (const item of v2.items ?? []) {
      if (item.type === 'timeline') add(FOLLOWING_FEED, !!item.pinned);
      else if (item.type === 'feed' && item.value && GENERATOR_URI_RE.test(item.value)) {
        add(item.value, !!item.pinned);
      }
    }
    return [...pinned, ...rest];
  }

  const v1 = preferences.find(
    (p): p is SavedFeedsPrefV1 =>
      (p as { $type?: string })?.$type === 'app.bsky.actor.defs#savedFeedsPref'
  );
  for (const uri of v1?.pinned ?? []) if (GENERATOR_URI_RE.test(uri)) add(uri, true);
  for (const uri of v1?.saved ?? []) if (GENERATOR_URI_RE.test(uri)) add(uri, false);
  return [...pinned, ...rest];
}

/**
 * GET /api/v2/bsky/feeds[?saved=1]
 *
 * The reader's Bluesky sources and what the session may do. With `saved=1`
 * (Manage Sources), also the feeds saved in Bluesky, each marked `added`; the
 * Following timeline always leads, saved or not.
 */
export async function handleGetBskyFeeds(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const a = access(session);
  const feeds = await listFeedSources(env, session.did);
  const body: Record<string, unknown> = { access: a, feeds };

  if (new URL(request.url).searchParams.get('saved') === '1') {
    let uris: string[] = [FOLLOWING_FEED];
    let savedError: string | null = null;
    if (a.feeds) {
      const prefs = await createPDSClient(session).getBskyPreferences();
      if (prefs.success) {
        uris = [FOLLOWING_FEED, ...savedFeedUris(prefs.data.preferences ?? [])];
        uris = [...new Set(uris)];
      } else {
        savedError = prefs.error;
        log.warn('bsky_preferences_failed', { did: session.did, error: prefs.error });
      }
    }
    const added = new Map(feeds.map((f) => [f.uri, f]));
    const cards = await fetchFeedGenerators(
      uris.filter((u) => u !== FOLLOWING_FEED && !added.has(u))
    );
    body.saved = uris
      .map((uri) => {
        if (uri === FOLLOWING_FEED) return { ...followingSource(), added: added.has(uri) };
        const card = added.get(uri) ?? cards.get(uri);
        return card
          ? {
              uri,
              displayName: card.displayName,
              ...(card.description ? { description: card.description } : {}),
              ...(card.avatar ? { avatar: card.avatar } : {}),
              added: added.has(uri),
            }
          : null;
      })
      .filter(Boolean);
    body.savedError = savedError;
  }

  return json(body);
}

function followingSource(): BskyFeedSource {
  return {
    uri: FOLLOWING_FEED,
    displayName: 'Following on Bluesky',
    description: 'Everything the people you follow on Bluesky post, newest first.',
  };
}

/**
 * POST /api/v2/bsky/feeds { uri }   add a Bluesky feed as a source
 * DELETE /api/v2/bsky/feeds { uri } remove it
 *
 * Adding needs no permission (the read does), so a reader can pick feeds before
 * the sign-in that grants reading them.
 */
export async function handleBskyFeedsWrite(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const body = await readJson<{ uri?: unknown }>(request);
  if (!body || !isFeedUri(body.uri)) {
    return json({ error: 'uri must be "following" or a feed generator at-uri' }, 400);
  }
  const uri = body.uri;

  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM bsky_feeds WHERE user_did = ? AND feed_uri = ?')
      .bind(session.did, uri)
      .run();
    return json({ ok: true });
  }

  const existing = await listFeedSources(env, session.did);
  const found = existing.find((f) => f.uri === uri);
  if (found) return json({ feed: found });
  if (existing.length >= MAX_BSKY_FEEDS) {
    return json({ error: `You can add up to ${MAX_BSKY_FEEDS} Bluesky feeds` }, 400);
  }

  let feed: BskyFeedSource;
  if (uri === FOLLOWING_FEED) {
    feed = followingSource();
  } else {
    const card = (await fetchFeedGenerators([uri])).get(uri);
    if (!card) return json({ error: 'Feed not found' }, 404);
    feed = {
      uri,
      displayName: card.displayName,
      ...(card.description ? { description: card.description } : {}),
      ...(card.avatar ? { avatar: card.avatar } : {}),
    };
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO bsky_feeds (user_did, feed_uri, display_name, description, avatar, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      session.did,
      feed.uri,
      feed.displayName,
      feed.description ?? null,
      feed.avatar ?? null,
      Date.now()
    )
    .run();
  return json({ feed });
}

/**
 * GET /api/v2/bsky/feed?uri=&cursor=&limit=
 *
 * One page of a Bluesky feed, read live through the reader's PDS and normalized
 * for the river. Nothing is stored: a feed is Bluesky's, and it pages by cursor.
 */
export async function handleGetBskyFeed(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const uri = params.get('uri');
  if (!isFeedUri(uri)) {
    return json({ error: 'uri must be "following" or a feed generator at-uri' }, 400);
  }
  if (!canRead(session, uri)) return json({ scopeRequired: true, posts: [], cursor: null });

  const cursor = params.get('cursor') || undefined;
  const limit = Math.min(
    FEED_PAGE_MAX,
    Math.max(1, Number.parseInt(params.get('limit') ?? '', 10) || FEED_PAGE_DEFAULT)
  );

  const pds = createPDSClient(session);
  const result =
    uri === FOLLOWING_FEED
      ? await pds.getTimeline<RawFeedItem>(cursor, limit)
      : await pds.getFeed<RawFeedItem>(uri, cursor, limit);
  if (!result.success) {
    log.warn('bsky_feed_failed', { did: session.did, feed: uri, error: result.error });
    return json({ error: 'Bluesky did not answer', detail: result.error }, 502);
  }

  return json({
    scopeRequired: false,
    posts: normalizeFeed(result.data.feed),
    cursor: result.data.cursor ?? null,
  });
}

/** The collection + rkey of one of the reader's own records, or null. */
function ownRecord(
  session: Session,
  uri: unknown,
  collection: string
): { collection: string; rkey: string } | null {
  if (typeof uri !== 'string') return null;
  const prefix = `at://${session.did}/${collection}/`;
  if (!uri.startsWith(prefix)) return null;
  const rkey = uri.slice(prefix.length);
  return /^[a-zA-Z0-9._:~-]{1,512}$/.test(rkey) ? { collection, rkey } : null;
}

function isStrongRef(ref: unknown): ref is { uri: string; cid: string } {
  const r = ref as { uri?: unknown; cid?: unknown } | null;
  return (
    !!r &&
    typeof r.uri === 'string' &&
    POST_URI_RE.test(r.uri) &&
    typeof r.cid === 'string' &&
    /^[a-z0-9]{8,128}$/.test(r.cid)
  );
}

/**
 * POST   /api/v2/bsky/like|repost  { uri, cid }   → { uri } of the new record
 * DELETE /api/v2/bsky/like|repost  { uri }        the reader's like/repost record
 */
export async function handleBskySubjectRecord(
  request: Request,
  session: Session,
  kind: 'like' | 'repost'
): Promise<Response> {
  if (!access(session).write) return insufficientScopesResponse('blueskyWrite');
  const collection = kind === 'like' ? 'app.bsky.feed.like' : 'app.bsky.feed.repost';
  const body = await readJson<{ uri?: unknown; cid?: unknown }>(request);
  if (!body) return json({ error: 'Invalid JSON' }, 400);
  const pds = createPDSClient(session);

  if (request.method === 'DELETE') {
    const own = ownRecord(session, body.uri, collection);
    if (!own) return json({ error: `uri must be one of your ${kind} records` }, 400);
    const result = await pds.deleteRecord(own.collection, own.rkey);
    if (!result.success) return json({ error: result.error }, 502);
    return json({ ok: true });
  }

  const subject = { uri: body.uri, cid: body.cid };
  if (!isStrongRef(subject)) return json({ error: 'uri and cid must name a post' }, 400);
  const result = await pds.createRecord(collection, {
    $type: collection,
    subject: { uri: subject.uri, cid: subject.cid },
    createdAt: new Date().toISOString(),
  });
  if (!result.success) return json({ error: result.error }, 502);
  return json({ uri: result.data.uri });
}

/**
 * POST /api/v2/bsky/post { text, reply?: { root, parent } }  → { uri, cid, url }
 *
 * A reply (or a post) as the reader. Links, @mentions and #tags in the text
 * become facets, the way Bluesky's composer makes them.
 */
export async function handleBskyPost(request: Request, session: Session): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!access(session).write) return insufficientScopesResponse('blueskyWrite');

  const body = await readJson<{ text?: unknown; reply?: { root?: unknown; parent?: unknown } }>(
    request
  );
  if (!body) return json({ error: 'Invalid JSON' }, 400);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: 'text is required' }, 400);
  if (graphemeLength(text) > POST_MAX_GRAPHEMES) {
    return json({ error: `Posts are at most ${POST_MAX_GRAPHEMES} characters` }, 400);
  }
  let reply: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } } | null =
    null;
  if (body.reply !== undefined) {
    const { root, parent } = body.reply ?? {};
    if (!isStrongRef(root) || !isStrongRef(parent)) {
      return json({ error: 'reply.root and reply.parent must name posts' }, 400);
    }
    reply = {
      root: { uri: root.uri, cid: root.cid },
      parent: { uri: parent.uri, cid: parent.cid },
    };
  }

  const detected = detectFacets(text);
  const dids = new Map<string, string>();
  await Promise.all(
    detected.handles.slice(0, MAX_MENTIONS).map(async (handle) => {
      try {
        const did = await resolveHandle(handle);
        if (did?.startsWith('did:')) dids.set(handle, did);
      } catch {
        // An unresolvable handle stays plain text.
      }
    })
  );
  const facets = resolveMentions(detected.facets, dids);

  const record = {
    $type: 'app.bsky.feed.post',
    text,
    ...(facets.length ? { facets } : {}),
    ...(reply ? { reply } : {}),
    createdAt: new Date().toISOString(),
  };
  const result = await createPDSClient(session).createRecord('app.bsky.feed.post', record);
  if (!result.success) return json({ error: result.error }, 502);
  const rkey = result.data.uri.split('/').pop();
  return json({
    uri: result.data.uri,
    cid: result.data.cid,
    url: `https://bsky.app/profile/${session.did}/post/${rkey}`,
  });
}
