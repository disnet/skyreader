import { Database } from 'bun:sqlite';
import { normalizeArticleUrl, constellationTargets } from './url-normalize';
import { constellationGetResult } from './constellation-client';
import { getRecordValue, resolveProfile, MentionLaneUnavailableError } from './mention-lane';
import { resolveHandle } from './did-resolver';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_NOTES = 50;
const RECORD_CONCURRENCY = 6;
const LINKS_PAGE_SIZE = 100;
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

export async function getMarginHighlights(
  db: Database,
  rawUrl: string
): Promise<MarginHighlightsResult> {
  const normUrl = normalizeArticleUrl(rawUrl);
  if (!normUrl) return { notes: [], capped: false };
  const key = `margin-highlights:${normUrl}`;
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
  const request = resolveMarginHighlights(db, normUrl, key, now);
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
  key: string,
  now: number
): Promise<MarginHighlightsResult> {
  const sources: Array<{ target: string; path: string }> = [];
  let unreachable = false;
  for (const target of constellationTargets(normUrl)) {
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
  const profiles = new Map(
    await Promise.all(
      [...new Set(records.map((r) => r.did))].map(
        async (did) =>
          [
            did,
            { ...(await resolveProfile(db, did)), handle: await resolveHandle(db, did) },
          ] as const
      )
    )
  );
  const notes: MarginHighlightNote[] = [];
  for (const { record, value } of values) {
    const target = value?.target as Record<string, unknown> | undefined;
    const selector = target?.selector as Record<string, unknown> | undefined;
    const exact = typeof selector?.exact === 'string' ? selector.exact.trim().slice(0, 5000) : '';
    if (!exact) continue;
    const profile = profiles.get(record.did);
    const optional = (name: string, cap: number) =>
      typeof selector?.[name] === 'string' && selector[name]
        ? String(selector[name]).slice(0, cap)
        : undefined;
    notes.push({
      did: record.did,
      handle: profile?.handle ?? null,
      displayName: profile?.displayName ?? null,
      avatar: profile?.avatar ?? null,
      createdAt: typeof value?.createdAt === 'string' ? value.createdAt : null,
      motivation: typeof value?.motivation === 'string' ? value.motivation : null,
      note: typeof value?.body === 'string' ? value.body.trim().slice(0, 2000) || null : null,
      selector: {
        type: 'TextQuoteSelector',
        exact,
        ...(optional('prefix', 500) ? { prefix: optional('prefix', 500) } : {}),
        ...(optional('suffix', 500) ? { suffix: optional('suffix', 500) } : {}),
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
