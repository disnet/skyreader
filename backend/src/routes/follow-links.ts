// From your follows (docs/plans/FOLLOWS_LINKS_PLAN.md): the links people you
// follow on Bluesky are sharing, grouped by article.
//
//   GET  /api/v2/following-links?window=24h|3d|7d   serve from D1, refresh behind
//        (200 { scopeRequired: true } until the reader grants getTimeline)
//   GET  /api/v2/following-links/for?url=           who you follow shared one URL
//   POST /api/v2/following-links/settings           { inEverything } (no scope needed)
//   GET  /api/v2/following-links/probe              local-dev diagnostic (Phase 0)

import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { createPDSClient } from '../services/pds-client';
import { FOLLOWS_LINKS_ACCESS_SCOPES, FOLLOWS_LINKS_SCOPES } from '../config/scopes';
import { extractLinkShare, type LinkShare, type TimelineItem } from '../services/follow-links';
import {
  FOLLOW_LINKS_SCOPE_DENIED,
  FOLLOW_LINKS_WINDOWS,
  followLinksNeedRefresh,
  readFollowLinkSharers,
  readFollowLinks,
  readFollowLinksInEverything,
  readFollowLinksSync,
  refreshFollowLinks,
  setFollowLinksInEverything,
  type FollowLinksWindow,
} from '../services/follow-links-store';
import { hasRequiredScopes } from './auth';
import { grantsScopes } from '../services/scope-check';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { log, serializeError } from '../utils/logger';

const PROBE_MAX_PAGES = 5;
/**
 * A reader who granted `aud=*` after their PDS refused the narrow grant tries
 * again at once instead of waiting out the refresh gate, but no more often than
 * this, in case their PDS refuses that too.
 */
const SCOPE_RETRY_MS = 60 * 1000;

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
  // Answered with or without the permission: the first-run question in
  // Everything is asked before it's granted.
  const inEverything = await readFollowLinksInEverything(env, session.did);
  if (!hasRequiredScopes(session.grantedScopes, FOLLOWS_LINKS_ACCESS_SCOPES)) {
    return json({ scopeRequired: true, inEverything, links: [], sync: null });
  }

  const param = new URL(request.url).searchParams.get('window') ?? '24h';
  if (!Object.hasOwn(FOLLOW_LINKS_WINDOWS, param)) {
    return json({ error: 'window must be one of 24h, 3d, 7d' }, 400);
  }
  const window = param as FollowLinksWindow;

  const now = Date.now();
  const [sync, links] = await Promise.all([
    readFollowLinksSync(env, session.did),
    readFollowLinks(env, session.did, window, now),
  ]);

  // The PDS refused the timeline for want of scope. A session holding only the
  // narrow grant is asked to grant again, which asks for `aud=*` (see
  // FOLLOWS_LINKS_SCOPES); one that already holds it retries past the gate.
  let force = false;
  if (sync?.error === FOLLOW_LINKS_SCOPE_DENIED) {
    if (!grantsScopes(session.grantedScopes, FOLLOWS_LINKS_SCOPES)) {
      return json({ scopeRequired: true, inEverything, links: [], sync: null });
    }
    force = now - sync.lastPollAt >= SCOPE_RETRY_MS;
  }

  const refreshing = force || followLinksNeedRefresh(sync, now);
  if (refreshing) {
    ctx.waitUntil(
      refreshFollowLinks(env, session, { force }).catch((error) => {
        log.error('follow_links_refresh_threw', { did: session.did, ...serializeError(error) });
      })
    );
  }

  return json({
    scopeRequired: false,
    inEverything,
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

/**
 * GET /api/v2/following-links/for?url=
 *
 * The people you follow who shared this article, for the reader's Discussion
 * panel. Served from what the last refresh stored; it never walks the timeline
 * itself (the follows channel and Home's lane do that), so opening an article costs one
 * indexed query. Without the scope it answers empty, quietly: the panel is no
 * place to ask for a permission.
 */
export async function handleFollowLinkSharers(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (!hasRequiredScopes(session.grantedScopes, FOLLOWS_LINKS_ACCESS_SCOPES)) {
    return json({ scopeRequired: true, sharers: [] });
  }
  const raw = new URL(request.url).searchParams.get('url');
  const urlNormalized = raw ? normalizeArticleUrl(raw) : null;
  if (!urlNormalized) return json({ error: 'Missing or invalid url' }, 400);
  const sharers = await readFollowLinkSharers(env, session.did, urlNormalized);
  return json({ scopeRequired: false, sharers });
}

/**
 * POST /api/v2/following-links/settings  { inEverything: boolean }
 *
 * Whether follows links show in Everything. Needs no permission: "not now" is
 * an answer someone gives before granting it, and "yes" is saved before the
 * sign-in that grants it, so it's already on when they come back.
 */
export async function handleFollowLinksSettings(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: { inEverything?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (typeof body.inEverything !== 'boolean') {
    return json({ error: 'inEverything must be a boolean' }, 400);
  }
  await setFollowLinksInEverything(env, session.did, body.inEverything);
  return json({ ok: true, inEverything: body.inEverything });
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
      required: FOLLOWS_LINKS_ACCESS_SCOPES,
      requested: FOLLOWS_LINKS_SCOPES,
      granted: granted.filter((s) => s.startsWith('rpc:') || s === 'atproto'),
      hasRequired: grantsScopes(session.grantedScopes, FOLLOWS_LINKS_ACCESS_SCOPES),
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
