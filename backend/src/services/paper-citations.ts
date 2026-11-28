/**
 * The works citing a paper, for the Cited by tab in the discussion under it
 * (docs/plans/SAVE_WATCHES.md § Cited by).
 *
 * One free OpenAlex lookup by DOI gives the work's id and `cited_by_count`;
 * only when that's above zero does a list call (which counts against the key's
 * daily budget) fetch the most-cited citing works. The answer is cached per DOI
 * in `paper_citations`, shared by every reader: a week when OpenAlex knows the
 * paper, a day when it doesn't (it may index it soon). A failure is not cached.
 */

import type { Env } from '../types';
import { exactDoi } from './export/identifiers';
import { openAlex, openAlexShortId, type OpenAlexWork } from './openalex';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** How long a paper OpenAlex knows is served from the cache. */
export const CITATIONS_TTL_MS = 7 * DAY;
/** How long "OpenAlex has no such work" is believed. */
export const CITATIONS_MISS_TTL_MS = DAY;
/** Rows this long past their fetch (stale for weeks by then) are swept. */
const CITATIONS_RETENTION_MS = 30 * DAY;
/** Citing works listed: the most-cited, so the ones worth reading come first. */
export const CITING_WORKS_LISTED = 10;
/** Authors named per work before "et al.". */
const AUTHORS_NAMED = 3;
const TITLE_MAX = 300;

export interface CitingWork {
  title: string;
  /** The first few authors. */
  authors: string[];
  /** How many more authors there are. */
  moreAuthors: number;
  year: number | null;
  /** The journal, conference or repository. */
  venue: string | null;
  /** The work's DOI, when it has one. */
  doi: string | null;
  /** Where to read it: its doi.org link, else its OpenAlex page. */
  url: string;
  /** How often it's been cited itself. */
  citedBy: number;
}

export interface PaperCitations {
  doi: string;
  /** Every work OpenAlex knows citing this one; 0 when it doesn't know the paper. */
  total: number;
  /** The most-cited of them, up to CITING_WORKS_LISTED. */
  works: CitingWork[];
  /** All of them on openalex.org, when OpenAlex knows the paper. */
  allUrl: string | null;
  /** When OpenAlex was asked (ms). */
  fetchedAt: number;
}

interface CacheRow {
  doi: string;
  openalex_id: string | null;
  total: number;
  works: string | null;
  fetched_at: number;
}

/** The DOI a query names, lowercased (DOIs are case-insensitive), or null. */
export function citationDoi(raw: string | null): string | null {
  return exactDoi(raw)?.toLowerCase() ?? null;
}

function allUrlFor(openAlexId: string | null): string | null {
  return openAlexId
    ? `https://openalex.org/works?filter=${encodeURIComponent(`cites:${openAlexId}`)}`
    : null;
}

function fromRow(row: CacheRow): PaperCitations {
  let works: CitingWork[] = [];
  try {
    const parsed = row.works ? JSON.parse(row.works) : [];
    if (Array.isArray(parsed)) works = parsed as CitingWork[];
  } catch {
    // A row that doesn't parse reads as no works; the count still stands.
  }
  return {
    doi: row.doi,
    total: row.total,
    works,
    allUrl: allUrlFor(row.openalex_id),
    fetchedAt: row.fetched_at,
  };
}

/** One citing work as the tab shows it, or null without a title or a link. */
export function citingWork(w: OpenAlexWork): CitingWork | null {
  const title = w.display_name?.trim();
  const doiUrl = w.doi && /^https:\/\/doi\.org\/10\./i.test(w.doi) ? w.doi : null;
  const url = doiUrl ?? (w.id && /^https:\/\/openalex\.org\/W\d+$/.test(w.id) ? w.id : null);
  if (!title || !url) return null;
  const names = (w.authorships ?? [])
    .map((a) => a?.author?.display_name?.trim())
    .filter((n): n is string => Boolean(n));
  return {
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title,
    authors: names.slice(0, AUTHORS_NAMED),
    moreAuthors: Math.max(0, names.length - AUTHORS_NAMED),
    year: typeof w.publication_year === 'number' ? w.publication_year : null,
    venue: w.primary_location?.source?.display_name?.trim() || null,
    doi: doiUrl ? doiUrl.slice('https://doi.org/'.length) : null,
    url,
    citedBy: typeof w.cited_by_count === 'number' ? w.cited_by_count : 0,
  };
}

async function fetchFromOpenAlex(
  env: Env,
  doi: string
): Promise<{ openAlexId: string | null; total: number; works: CitingWork[] }> {
  // A single lookup by DOI: free and uncapped on OpenAlex's pricing.
  const work = await openAlex<OpenAlexWork>(env, `/works/doi:${encodeURIComponent(doi)}`, {
    select: 'id,cited_by_count',
  });
  const openAlexId = openAlexShortId(work?.id);
  const total = work?.cited_by_count ?? 0;
  if (!openAlexId || total <= 0) return { openAlexId, total: openAlexId ? total : 0, works: [] };
  const page = await openAlex<{ results?: OpenAlexWork[] }>(env, '/works', {
    filter: `cites:${openAlexId}`,
    sort: 'cited_by_count:desc',
    per_page: String(CITING_WORKS_LISTED),
    select: 'id,doi,display_name,publication_year,cited_by_count,authorships,primary_location',
  });
  const works = (page?.results ?? []).map(citingWork).filter((w): w is CitingWork => w !== null);
  return { openAlexId, total, works };
}

/**
 * The works citing the paper with this (lowercased) DOI: from the cache while
 * it's fresh, else from OpenAlex. Throws when OpenAlex fails and nothing is
 * cached; a stale row is served instead of failing.
 */
export async function getPaperCitations(
  env: Env,
  doi: string,
  now = Date.now()
): Promise<PaperCitations> {
  const row = await env.DB.prepare(
    `SELECT doi, openalex_id, total, works, fetched_at FROM paper_citations WHERE doi = ?`
  )
    .bind(doi)
    .first<CacheRow>();
  if (row) {
    const ttl = row.openalex_id ? CITATIONS_TTL_MS : CITATIONS_MISS_TTL_MS;
    if (now - row.fetched_at < ttl) return fromRow(row);
  }
  let fresh: Awaited<ReturnType<typeof fetchFromOpenAlex>>;
  try {
    fresh = await fetchFromOpenAlex(env, doi);
  } catch (error) {
    if (row) return fromRow(row);
    throw error;
  }
  const works = fresh.works.length ? JSON.stringify(fresh.works) : null;
  await env.DB.prepare(
    `INSERT INTO paper_citations (doi, openalex_id, total, works, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(doi) DO UPDATE SET openalex_id = excluded.openalex_id,
       total = excluded.total, works = excluded.works, fetched_at = excluded.fetched_at`
  )
    .bind(doi, fresh.openAlexId, fresh.total, works, now)
    .run();
  return {
    doi,
    total: fresh.total,
    works: fresh.works,
    allUrl: allUrlFor(fresh.openAlexId),
    fetchedAt: now,
  };
}

/** Hourly: drop rows past their retention. */
export async function prunePaperCitations(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare(`DELETE FROM paper_citations WHERE fetched_at < ?`)
    .bind(now - CITATIONS_RETENTION_MS)
    .run();
}
