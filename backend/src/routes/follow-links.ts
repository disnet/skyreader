// From your follows (docs/plans/FOLLOWS_LINKS_PLAN.md): the links people you
// follow on Bluesky are sharing, grouped by article.
//
//   GET  /api/v2/following-links?window=24h|3d|7d   serve from D1, refresh behind
//        (200 { scopeRequired: true } until the reader grants getTimeline)
//   POST /api/v2/following-links/state              opened / dismissed / restored
//   GET  /api/v2/following-links/probe              local-dev diagnostic (Phase 0)

import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { createPDSClient } from '../services/pds-client';
import { FOLLOWS_LINKS_SCOPES } from '../config/scopes';
import { extractLinkShare, type LinkShare, type TimelineItem } from '../services/follow-links';
import {
  FOLLOW_LINKS_WINDOWS,
  followLinksNeedRefresh,
  readFollowLinks,
  readFollowLinksSync,
  refreshFollowLinks,
  setFollowLinkState,
  type FollowLinkAction,
  type FollowLinksWindow,
} from '../services/follow-links-store';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { log, serializeError } from '../utils/logger';

const PROBE_MAX_PAGES = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tally(map: Record<string, number>, key: string | undefined): void {
  const k = key ?? '(none)';
  map[k] = (map[k] ?? 0) + 1;
}

/**
 * GET /api/v2/following-links?window=24h|3d|7d
 *
 * Answers from D1 straight away and, when the last refresh is older than the
 * gate, starts one under waitUntil. `sync.complete` is false until a reader's
 * first refresh has finished; the client shows "gathering" and asks again.
 * `sync.refreshing` says one was started by this request.
 */
export async function handleGetFollowLinks(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  session: Session
): Promise<Response> {
  // Not a 403: the surface's empty state IS the permission prompt, and a 403
  // scope_upgrade_required would also raise the app-wide "log in again" banner
  // on every load of the page for anyone who hasn't opted in.
  if (!hasRequiredScopes(session.grantedScopes, FOLLOWS_LINKS_SCOPES)) {
    return json({ scopeRequired: true, links: [], sync: null });
  }

  const param = new URL(request.url).searchParams.get('window') ?? '24h';
  if (!(param in FOLLOW_LINKS_WINDOWS)) {
    return json({ error: 'window must be one of 24h, 3d, 7d' }, 400);
  }
  const window = param as FollowLinksWindow;

  const now = Date.now();
  const [sync, links] = await Promise.all([
    readFollowLinksSync(env, session.did),
    readFollowLinks(env, session.did, window, now),
  ]);

  const refreshing = followLinksNeedRefresh(sync, now);
  if (refreshing) {
    ctx.waitUntil(
      refreshFollowLinks(env, session).catch((error) => {
        log.error('follow_links_refresh_threw', { did: session.did, ...serializeError(error) });
      })
    );
  }

  return json({
    scopeRequired: false,
    window,
    links,
    sync: {
      complete: sync?.complete ?? false,
      refreshing,
      lastPollAt: sync?.lastPollAt ?? null,
      error: sync?.error ?? null,
    },
  });
}

const ACTIONS: FollowLinkAction[] = ['opened', 'dismissed', 'restored'];

/** POST /api/v2/following-links/state  { url, action: 'opened'|'dismissed'|'restored' } */
export async function handleFollowLinkState(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!hasRequiredScopes(session.grantedScopes, FOLLOWS_LINKS_SCOPES)) {
    return insufficientScopesResponse();
  }
  let body: { url?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const urlNormalized = typeof body.url === 'string' ? normalizeArticleUrl(body.url) : null;
  if (!urlNormalized) return json({ error: 'Missing or invalid url' }, 400);
  if (!ACTIONS.includes(body.action as FollowLinkAction)) {
    return json({ error: `action must be one of ${ACTIONS.join(', ')}` }, 400);
  }
  await setFollowLinkState(env, session.did, urlNormalized, body.action as FollowLinkAction);
  return json({ ok: true });
}

// Local dev is the one place FRONTEND_URL is a loopback address (.dev.vars).
// SENTRY_ENVIRONMENT can't tell us: `wrangler dev` inherits the top-level
// "production" from wrangler.toml.
function isLocalDev(env: Env): boolean {
  try {
    const host = new URL(env.FRONTEND_URL).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

/**
 * GET /api/v2/following-links/probe?pages=N
 *
 * Pages the session's Following timeline and reports what came back: the scopes
 * the session actually holds (the granted string can differ from the requested
 * one), per-page status, the reason/embed shapes seen, and the link shares the
 * extractor pulls out, grouped by URL the way the real surface will rank them.
 */
export async function handleFollowLinksProbe(request: Request, env: Env): Promise<Response> {
  if (!isLocalDev(env)) return json({ error: 'Not found' }, 404);

  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const pages = Math.min(
    PROBE_MAX_PAGES,
    Math.max(1, Number.parseInt(url.searchParams.get('pages') ?? '1', 10) || 1)
  );

  const granted = (session.grantedScopes ?? '').split(' ').filter(Boolean);
  const pds = createPDSClient(session);

  const pageReports: { status: 'ok' | 'error'; items?: number; error?: string }[] = [];
  const reasonTypes: Record<string, number> = {};
  const embedTypes: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const samples: Record<string, TimelineItem> = {};
  const shares: LinkShare[] = [];
  let itemCount = 0;
  let oldest: string | undefined;
  let newest: string | undefined;
  let cursor: string | undefined;
  const started = Date.now();

  for (let i = 0; i < pages; i++) {
    const res = await pds.getTimeline<TimelineItem>(cursor, 100);
    if (!res.success) {
      pageReports.push({ status: 'error', error: res.error });
      break;
    }
    const feed = res.data.feed ?? [];
    pageReports.push({ status: 'ok', items: feed.length });

    for (const item of feed) {
      itemCount++;
      tally(reasonTypes, item.reason?.$type);
      tally(embedTypes, item.post?.embed?.$type);
      const at = item.reason?.indexedAt ?? item.post?.indexedAt;
      if (at && (!oldest || at < oldest)) oldest = at;
      if (at && (!newest || at > newest)) newest = at;

      // Keep one raw example of each shape worth eyeballing.
      const shape = item.reason?.$type ?? item.post?.embed?.$type;
      if (shape && !samples[shape]) samples[shape] = item;

      const share = extractLinkShare(item, session.did);
      if (share) {
        shares.push(share);
      } else if (item.post?.record?.reply) {
        tally(skipped, 'reply');
      } else {
        tally(skipped, 'no-link-or-filtered');
      }
    }

    cursor = res.data.cursor;
    if (!cursor || feed.length === 0) break;
  }

  // Group the way the surface will: distinct sharers per normalized URL.
  const groups = new Map<string, { url: string; title?: string; sharers: Set<string> }>();
  for (const s of shares) {
    const g = groups.get(s.urlNormalized) ?? {
      url: s.url,
      title: s.card?.title,
      sharers: new Set<string>(),
    };
    g.title ??= s.card?.title;
    g.sharers.add(s.sharer.handle ?? s.sharer.did);
    groups.set(s.urlNormalized, g);
  }
  const top = [...groups.values()]
    .sort((a, b) => b.sharers.size - a.sharers.size)
    .slice(0, 25)
    .map((g) => ({ url: g.url, title: g.title, sharers: [...g.sharers] }));

  const byKind: Record<string, number> = {};
  for (const s of shares) tally(byKind, s.kind);

  return json({
    did: session.did,
    pdsUrl: session.pdsUrl,
    scope: {
      required: FOLLOWS_LINKS_SCOPES,
      granted: granted.filter((s) => s.startsWith('rpc:') || s === 'atproto'),
      hasRequired: FOLLOWS_LINKS_SCOPES.every((s) => granted.includes(s)),
    },
    elapsedMs: Date.now() - started,
    pages: pageReports,
    items: itemCount,
    window: { newest, oldest },
    reasonTypes,
    embedTypes,
    shares: { total: shares.length, byKind, skipped, distinctUrls: groups.size },
    top,
    samples,
  });
}
