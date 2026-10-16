/**
 * `GET /api/search` — full-text search over what the reader has read, saved and
 * highlighted (Supporter). The index is the reader's own Durable Object
 * (durable-objects/search-index.ts); this route checks access, parses the query
 * into safe FTS5 syntax, and forwards it.
 *
 *   q      the query (see services/search-query.ts for the forms it accepts)
 *   kind   read | saved | highlighted, comma-separated; omitted = everything
 *   since  only items touched at or after this unix-ms time
 *   limit  1–50, default 20
 *   offset for paging, ≤ 1000
 */

import type { Env, Session } from '../types';
import { parseSearchQuery } from '../services/search-query';
import {
  KIND_HIGHLIGHTED,
  KIND_READ,
  KIND_SAVED,
  getSearchAccess,
  searchIndexStub,
} from '../services/search-index';
import { SEARCH_COUNT_CAP } from '../durable-objects/search-index';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const KIND_NAMES: Record<string, number> = {
  read: KIND_READ,
  saved: KIND_SAVED,
  highlighted: KIND_HIGHLIGHTED,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export async function handleSearch(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const access = await getSearchAccess(env, session.did);
  // Off in this environment: as if the route didn't exist, so a client can't
  // tell "not rolled out" from "not deployed".
  if (!access.enabled) return json({ error: 'Not found' }, 404);
  if (!access.entitled) {
    return json({ error: 'Search is a Supporter feature', code: 'upgrade_required' }, 403);
  }

  const url = new URL(request.url);
  const parsed = parseSearchQuery(url.searchParams.get('q') ?? '');
  if (!parsed) return json({ error: 'Nothing to search for', code: 'empty_query' }, 400);

  let kinds = 0;
  for (const name of (url.searchParams.get('kind') ?? '').split(',')) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const bit = KIND_NAMES[trimmed];
    if (!bit) return json({ error: `Unknown kind: ${trimmed}` }, 400);
    kinds |= bit;
  }

  const result = await searchIndexStub(env, session.did).search(
    session.did,
    { positives: parsed.positives, negatives: parsed.negatives },
    {
      kinds,
      since: intParam(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER),
      limit: intParam(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT),
      offset: intParam(url.searchParams.get('offset'), 0, 0, SEARCH_COUNT_CAP),
    }
  );

  return json({
    terms: parsed.terms,
    results: result.hits.map((hit) => ({
      itemKey: hit.itemKey,
      itemType: hit.itemType,
      url: hit.url,
      title: hit.title,
      feedTitle: hit.feedTitle || null,
      feedUrl: hit.feedUrl,
      read: (hit.kinds & KIND_READ) !== 0,
      saved: (hit.kinds & KIND_SAVED) !== 0,
      highlighted: (hit.kinds & KIND_HIGHLIGHTED) !== 0,
      readAt: hit.readAt,
      savedAt: hit.savedAt,
      highlightedAt: hit.highlightedAt,
      snippet: hit.snippet,
    })),
    total: Math.min(result.total, SEARCH_COUNT_CAP),
    totalCapped: result.total > SEARCH_COUNT_CAP,
    index: { items: result.indexedItems, building: result.building },
  });
}
