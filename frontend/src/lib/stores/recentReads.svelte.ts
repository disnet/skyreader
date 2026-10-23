// What the reader has just read, newest first: the likely other end of a Semble
// connection. Most connections are "this made me think of that", and "that" is
// usually the article before this one.
//
// Per device, in localStorage, per account. This is a convenience for drawing an
// edge, not reading history to sync: read state already lives server-side, but
// nothing there keeps the order the last few articles were opened in. Losing it
// (private window, cleared storage) only costs the suggestion.
import { auth } from '$lib/stores/auth.svelte';

export interface RecentRead {
  url: string;
  title?: string;
  /** When it was read (ms). */
  at: number;
}

const KEY_PREFIX = 'skyreader-recent-reads:';
/** Enough to rank the Connect dialog's recent list; not a history. */
const CAP = 20;
/** "The article before this one" stops meaning anything after a couple of days. */
export const PREVIOUS_READ_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** "/post" and "/post/#top" are the same article for "is this the one I'm on". */
export function sameArticle(a: string, b: string): boolean {
  const strip = (url: string) => url.replace(/#.*$/, '').replace(/\/+$/, '');
  return strip(a) === strip(b);
}

function parse(raw: string | null): RecentRead[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is RecentRead =>
        entry &&
        typeof entry.url === 'string' &&
        typeof entry.at === 'number' &&
        (entry.title === undefined || typeof entry.title === 'string')
    );
  } catch {
    return [];
  }
}

function load(did: string): RecentRead[] {
  try {
    return parse(localStorage.getItem(KEY_PREFIX + did));
  } catch {
    return [];
  }
}

function createRecentReadsStore() {
  // Loaded lazily per account and written through. The getter falls back to a
  // plain storage read rather than filling this in, since it runs inside
  // $derived, where writing state isn't allowed.
  let byDid = $state<Record<string, RecentRead[]>>({});

  function list(): RecentRead[] {
    const did = auth.user?.did;
    if (!did) return [];
    return byDid[did] ?? load(did);
  }

  /** Note that the reader just read `url`. A guest can't connect, so isn't tracked. */
  function record(url: string, title?: string | null) {
    const did = auth.user?.did;
    if (!did || !isHttpUrl(url)) return;
    const current = byDid[did] ?? load(did);
    const cleanTitle = title?.trim() || undefined;
    const head = current[0];
    // Re-opening what's already on top only refreshes it.
    if (head && sameArticle(head.url, url) && head.title === cleanTitle) return;
    const next = [
      { url, title: cleanTitle, at: Date.now() },
      ...current.filter((entry) => !sameArticle(entry.url, url)),
    ].slice(0, CAP);
    byDid[did] = next;
    try {
      localStorage.setItem(KEY_PREFIX + did, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the suggestion lasts for this tab only.
    }
  }

  /** The article read before `url`, if it was recent enough to still be on the reader's mind. */
  function previousBefore(url: string, now = Date.now()): RecentRead | null {
    for (const entry of list()) {
      if (sameArticle(entry.url, url)) continue;
      return now - entry.at <= PREVIOUS_READ_WINDOW_MS ? entry : null;
    }
    return null;
  }

  return {
    /** Newest first, for the signed-in reader. */
    get entries() {
      return list();
    },
    record,
    previousBefore,
  };
}

export const recentReadsStore = createRecentReadsStore();
