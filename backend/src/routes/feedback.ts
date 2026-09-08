import type { Env, Session } from '../types';
import { reportError } from '../observability/sentry';
import { log, serializeError } from '../utils/logger';

const PROFILE_BATCH_SIZE = 25;

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
  const cacheKey = new Request(new URL('/api/v2/feedback', request.url).toString());
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) return new Response(cached.body, cached);

  const apiBase = env.USERINPUT_API_URL || 'https://userinput.app';
  try {
    const boardUrl = new URL(
      `/api/board/${encodeURIComponent(env.USERINPUT_SPACE_DID)}/${encodeURIComponent(env.USERINPUT_SPACE_RKEY)}`,
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
    reportError(error, { tags: { route: 'feedback' } });
    return json({ error: 'Failed to load feedback' }, 502);
  }
}
