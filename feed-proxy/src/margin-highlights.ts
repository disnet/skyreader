import { Database } from 'bun:sqlite';
import { normalizeArticleUrl, constellationTargets } from './url-normalize';
import { constellationGetResult } from './constellation-client';
import { getRecordValue, resolveProfile, MentionLaneUnavailableError } from './mention-lane';
import { resolveHandle } from './did-resolver';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_NOTES = 50;
const RECORD_CONCURRENCY = 6;
const LINKS_PAGE_SIZE = 100;
const MARGIN_API_BASE = 'https://margin.at';
const MARGIN_API_TIMEOUT_MS = 5 * 1000;
const inFlight = new WeakMap<Database, Map<string, Promise<MarginHighlightsResult>>>();
export { MentionLaneUnavailableError };

export interface MarginHighlightNote {
  did: string;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  createdAt: string | null;
  motivation: string | null;
  note: string | null;
  selector: { type: 'TextQuoteSelector'; exact: string; prefix?: string; suffix?: string };
}
export interface MarginHighlightsResult {
  notes: MarginHighlightNote[];
  capped: boolean;
}
interface LinksAll {
  links?: Record<string, Record<string, { records?: number }>>;
}
interface Links {
  linking_records?: Array<{ did: string; collection: string; rkey: string }>;
}
interface CacheRow {
  context_json: string;
  cached_at: number;
}

function optionalString(value: unknown, cap: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, cap) : undefined;
}

function marginBodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>).value;
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * Margin's public index searches target URLs as text, then returns hydrated
 * notes. Unlike Constellation's exact-string backlink lookup, this finds legacy
 * records whose source has extra tracking parameters; normalize + filter the
 * results locally so similarly named pages can never bleed together.
 */
async function searchMarginIndex(normUrl: string): Promise<MarginHighlightsResult | null> {
  const url = new URL('/api/search', MARGIN_API_BASE);
  url.searchParams.set('q', normUrl);
  url.searchParams.set('limit', String(MAX_NOTES));
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)' },
      signal: AbortSignal.timeout(MARGIN_API_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { items?: unknown[] };
    if (!Array.isArray(data.items)) return null;

    const notes: MarginHighlightNote[] = [];
    for (const raw of data.items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (item.motivation !== 'highlighting') continue;
      const target = item.target as Record<string, unknown> | undefined;
      const source = typeof target?.source === 'string' ? target.source : '';
      if (normalizeArticleUrl(source) !== normUrl) continue;
      const selector = target?.selector as Record<string, unknown> | undefined;
      const exact = optionalString(selector?.exact, 5000)?.trim();
      const creator = item.creator as Record<string, unknown> | undefined;
      const did = optionalString(creator?.did, 256);
      if (!exact || !did) continue;
      notes.push({
        did,
        handle: optionalString(creator?.handle, 256) ?? null,
        displayName:
          optionalString(creator?.displayName, 256) ?? optionalString(creator?.name, 256) ?? null,
        avatar: optionalString(creator?.avatar, 2048) ?? null,
        createdAt: optionalString(item.createdAt, 64) ?? optionalString(item.created, 64) ?? null,
        motivation: 'highlighting',
        note: marginBodyText(item.body).trim().slice(0, 2000) || null,
        selector: {
          type: 'TextQuoteSelector',
          exact,
          ...(optionalString(selector?.prefix, 500)
            ? { prefix: optionalString(selector?.prefix, 500) }
            : {}),
          ...(optionalString(selector?.suffix, 500)
            ? { suffix: optionalString(selector?.suffix, 500) }
            : {}),
        },
      });
    }
    notes.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return { notes, capped: data.items.length >= MAX_NOTES };
  } catch {
    return null;
  }
}

export async function getMarginHighlights(
  db: Database,
  rawUrl: string
): Promise<MarginHighlightsResult> {
  const normUrl = normalizeArticleUrl(rawUrl);
  if (!normUrl) return { notes: [], capped: false };
  const targets = constellationTargets(normUrl, rawUrl);
  // A legacy tracked spelling adds exact lookup targets, so it must not reuse a
  // clean URL's cached zero (or vice versa).
  const key =
    rawUrl.trim() === normUrl
      ? `margin-highlights:${normUrl}`
      : `margin-highlights:${normUrl}:raw:${rawUrl.trim()}`;
  const now = Date.now();
  const cached = db
    .query<CacheRow, [string]>(
      'SELECT context_json, cached_at FROM constellation_cache WHERE cache_key = ?'
    )
    .get(key);
  if (cached && now - cached.cached_at < CACHE_TTL_MS) {
    try {
      const value = JSON.parse(cached.context_json);
      if (Array.isArray(value?.notes)) return value;
    } catch {
      /* recompute */
    }
  }

  let dbRequests = inFlight.get(db);
  if (!dbRequests) inFlight.set(db, (dbRequests = new Map()));
  const existing = dbRequests.get(key);
  if (existing) return existing;
  const request = resolveMarginHighlights(db, normUrl, targets, key, now);
  dbRequests.set(key, request);
  try {
    return await request;
  } finally {
    dbRequests.delete(key);
  }
}

async function resolveMarginHighlights(
  db: Database,
  normUrl: string,
  targets: string[],
  key: string,
  now: number
): Promise<MarginHighlightsResult> {
  const indexed = await searchMarginIndex(normUrl);
  if (indexed?.notes.length) {
    db.run(
      `INSERT INTO constellation_cache (cache_key, context_json, cached_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET context_json=excluded.context_json, cached_at=excluded.cached_at`,
      [key, JSON.stringify(indexed), now]
    );
    return indexed;
  }

  const sources: Array<{ target: string; path: string }> = [];
  let unreachable = false;
  for (const target of targets) {
    const all = await constellationGetResult<LinksAll>('/links/all', { target });
    if (!all.reachable) unreachable = true;
    for (const [collection, paths] of Object.entries(all.data?.links ?? {})) {
      if (collection !== 'at.margin.note') continue;
      for (const [path, stats] of Object.entries(paths))
        if (stats?.records) sources.push({ target, path });
    }
  }
  if (!sources.length && unreachable) throw new MentionLaneUnavailableError();

  const records: Array<{ did: string; collection: string; rkey: string }> = [];
  const seen = new Set<string>();
  let capped = false;
  for (const source of sources) {
    const links = await constellationGetResult<Links>('/links', {
      target: source.target,
      collection: 'at.margin.note',
      path: source.path,
      limit: String(LINKS_PAGE_SIZE),
    });
    if (!links.reachable) unreachable = true;
    if ((links.data?.linking_records?.length ?? 0) >= LINKS_PAGE_SIZE) capped = true;
    for (const record of links.data?.linking_records ?? []) {
      const id = `${record.did}/${record.collection}/${record.rkey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (records.length >= MAX_NOTES) {
        capped = true;
        break;
      }
      records.push(record);
    }
    if (capped) break;
  }
  if (!records.length && unreachable) throw new MentionLaneUnavailableError();

  const values: Array<{ record: (typeof records)[number]; value: Record<string, unknown> | null }> =
    [];
  for (let offset = 0; offset < records.length; offset += RECORD_CONCURRENCY) {
    values.push(
      ...(await Promise.all(
        records.slice(offset, offset + RECORD_CONCURRENCY).map(async (record) => ({
          record,
          value: await getRecordValue(db, record.did, record.collection, record.rkey),
        }))
      ))
    );
  }
  const profileEntries: Array<
    readonly [string, Awaited<ReturnType<typeof resolveProfile>> & { handle: string | null }]
  > = [];
  const dids = [...new Set(records.map((r) => r.did))];
  for (let offset = 0; offset < dids.length; offset += RECORD_CONCURRENCY) {
    profileEntries.push(
      ...(await Promise.all(
        dids
          .slice(offset, offset + RECORD_CONCURRENCY)
          .map(
            async (did) =>
              [
                did,
                { ...(await resolveProfile(db, did)), handle: await resolveHandle(db, did) },
              ] as const
          )
      ))
    );
  }
  const profiles = new Map(profileEntries);
  const notes: MarginHighlightNote[] = [];
  for (const { record, value } of values) {
    const target = value?.target as Record<string, unknown> | undefined;
    const selector = target?.selector as Record<string, unknown> | undefined;
    const exact = typeof selector?.exact === 'string' ? selector.exact.trim().slice(0, 5000) : '';
    if (!exact) continue;
    const profile = profiles.get(record.did);
    notes.push({
      did: record.did,
      handle: profile?.handle ?? null,
      displayName: profile?.displayName ?? null,
      avatar: profile?.avatar ?? null,
      createdAt: typeof value?.createdAt === 'string' ? value.createdAt : null,
      motivation: typeof value?.motivation === 'string' ? value.motivation : null,
      note: marginBodyText(value?.body).trim().slice(0, 2000) || null,
      selector: {
        type: 'TextQuoteSelector',
        exact,
        ...(optionalString(selector?.prefix, 500)
          ? { prefix: optionalString(selector?.prefix, 500) }
          : {}),
        ...(optionalString(selector?.suffix, 500)
          ? { suffix: optionalString(selector?.suffix, 500) }
          : {}),
      },
    });
  }
  notes.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const result = { notes, capped };
  db.run(
    `INSERT INTO constellation_cache (cache_key, context_json, cached_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET context_json=excluded.context_json, cached_at=excluded.cached_at`,
    [key, JSON.stringify(result), now]
  );
  return result;
}
