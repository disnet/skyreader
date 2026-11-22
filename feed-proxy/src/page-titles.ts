import type { Database } from 'bun:sqlite';
import { fetchArticlePage, type ArticlePageMeta } from './standard-site';
import { hashUrl } from './mentions';
import { normalizeArticleUrl } from './url-normalize';
import { Semaphore } from './semaphore';

// The real titles of the pages an article links to, for the reader's "Links in
// this article" list, where the article's own link text ("here", "an
// influential ally") rarely says what's behind it.
//
// One bounded origin fetch per page (fetchArticlePage, the link page's reader),
// cached here for a week. A page that couldn't be read (blocked, down, slow) or
// names no title is cached too, for a day, so a list that's opened again
// doesn't fetch it again; a fetch that threw isn't.
// A request waits a few seconds; fetches still running after that finish in the
// background and land in the cache, and the answer says `pending` so the
// reader asks once more.

/** Pages asked about in one request; the reader asks in chunks. */
export const PAGE_TITLES_MAX_URLS = 50;
/** How long a request waits for fetches before answering with what it has. */
export const PAGE_TITLES_BUDGET_MS = 4000;
const TITLE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const NO_TITLE_FRESH_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export function initPageTitles(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS page_title_cache (
      url_hash TEXT PRIMARY KEY,
      title TEXT,
      fetched_at INTEGER NOT NULL
    )
  `);
}

export interface PageTitlesResult {
  /** Each asked-for URL, as the caller sent it, whose page names a title. */
  titles: Record<string, string>;
  /** True when some page is still being read: asking again may find more. */
  pending: boolean;
}

type FetchPage = (url: string) => Promise<{ meta: ArticlePageMeta | null }>;

export function createPageTitles(
  db: Database,
  options: {
    fetchPage?: FetchPage;
    /** Origin fetches at once, across every request; the rest queue or are skipped. */
    concurrency?: number;
    queueMax?: number;
    budgetMs?: number;
    now?: () => number;
  } = {}
) {
  const fetchPage = options.fetchPage ?? fetchArticlePage;
  const gate = new Semaphore(options.concurrency ?? 6, options.queueMax ?? 300);
  const budgetMs = options.budgetMs ?? PAGE_TITLES_BUDGET_MS;
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<void>>();
  // Pages a busy proxy didn't get to on their last ask: not settled, so pending.
  const shed = new Set<string>();
  let prunedAt = 0;

  function cached(normUrl: string): { title: string | null } | undefined {
    const hash = hashUrl(normUrl);
    // The link page may have read this page already, or since we last did.
    const mention = db
      .query<{ page_meta: string | null }, [string]>(
        'SELECT page_meta FROM mention_cache WHERE url_hash = ?'
      )
      .get(hash);
    if (mention?.page_meta) {
      try {
        const title = (JSON.parse(mention.page_meta) as ArticlePageMeta).title;
        if (typeof title === 'string' && title) return { title };
      } catch {
        // A malformed row is a miss.
      }
    }
    const row = db
      .query<{ title: string | null; fetched_at: number }, [string]>(
        'SELECT title, fetched_at FROM page_title_cache WHERE url_hash = ?'
      )
      .get(hash);
    if (row) {
      const age = now() - row.fetched_at;
      if (age < (row.title ? TITLE_FRESH_MS : NO_TITLE_FRESH_MS)) return { title: row.title };
    }
    return undefined;
  }

  // Fetches the link as the article wrote it (a trailing slash or a `ref`
  // can matter to the server), cached under its normalized key.
  function read(normUrl: string, url: string): Promise<void> {
    const pending = inFlight.get(normUrl);
    if (pending) return pending;
    const work = (async () => {
      try {
        await gate.acquire();
      } catch {
        shed.add(normUrl); // Overloaded: not cached, and reported as pending.
        return;
      }
      try {
        const { meta } = await fetchPage(url);
        db.run(
          `INSERT INTO page_title_cache (url_hash, title, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT(url_hash) DO UPDATE SET title = excluded.title, fetched_at = excluded.fetched_at`,
          [hashUrl(normUrl), meta?.title ?? null, now()]
        );
      } catch (error) {
        console.error('[page-titles] read failed:', error);
      } finally {
        gate.release();
      }
    })().finally(() => inFlight.delete(normUrl));
    inFlight.set(normUrl, work);
    return work;
  }

  function prune(): void {
    if (now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = now();
    db.run('DELETE FROM page_title_cache WHERE fetched_at < ?', [now() - TITLE_FRESH_MS]);
  }

  return async function lookup(urls: string[]): Promise<PageTitlesResult> {
    prune();
    const titles: Record<string, string> = {};
    const waits: Promise<void>[] = [];
    const missing: [string, string][] = [];
    for (const url of urls) {
      const normUrl = normalizeArticleUrl(url);
      if (!normUrl) continue;
      const hit = cached(normUrl);
      if (hit) {
        if (hit.title) titles[url] = hit.title;
        continue;
      }
      missing.push([url, normUrl]);
      shed.delete(normUrl);
      waits.push(read(normUrl, url));
    }
    if (missing.length === 0) return { titles, pending: false };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      Promise.all(waits).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
      }),
    ]);
    clearTimeout(timer);

    let pending = !finished;
    for (const [url, normUrl] of missing) {
      const hit = cached(normUrl);
      if (hit?.title) titles[url] = hit.title;
      else if (!hit && (inFlight.has(normUrl) || shed.has(normUrl))) pending = true;
    }
    return { titles, pending };
  };
}
