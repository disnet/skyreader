// What the reader has just read, newest first: the likely other end of a Semble
// connection. Most connections are "this made me think of that", and "that" is
// usually something read just before this one.
//
// Per device, in localStorage, per account. This is a convenience for drawing an
// edge, not reading history to sync: read state already lives server-side, but
// nothing there keeps the order the last few articles were opened in. Losing it
// (private window, cleared storage) only costs the suggestion.
import { auth } from '$lib/stores/auth.svelte';
import { urlKey } from '$lib/utils/urlKey';

export interface RecentRead {
  url: string;
  title?: string;
  /** When it was read (ms). */
  at: number;
}

const KEY_PREFIX = 'skyreader-recent-reads:';
/** Enough for the recent-read cards; not a history. */
const CAP = 20;
/** Re-opening the top entry within this long doesn't rewrite storage. */
const REFRESH_AFTER_MS = 60 * 1000;

/** "/post", "/post/" and "/post?utm_source=…" are the same article. */
export function sameArticle(a: string, b: string): boolean {
  return a === b || (urlKey(a) ?? a) === (urlKey(b) ?? b);
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

/** Null when storage can't be read at all (blocked), as opposed to empty. */
function load(did: string): RecentRead[] | null {
  try {
    return parse(localStorage.getItem(KEY_PREFIX + did));
  } catch {
    return null;
  }
}

function createRecentReadsStore() {
  // Written through on every record, per account. Reads go to storage and only
  // track this, since they run inside $derived, where writing state isn't
  // allowed.
  let byDid = $state<Record<string, RecentRead[]>>({});

  function list(): RecentRead[] {
    const did = auth.user?.did;
    if (!did) return [];
    // Storage is the truth (another tab may have written since); the cached
    // copy is what makes a read reactive, and the fallback when it's blocked.
    const cached = byDid[did];
    return load(did) ?? cached ?? [];
  }

  /** Note that the reader just read `url`. A guest can't connect, so isn't tracked. */
  function record(url: string, title?: string | null) {
    const did = auth.user?.did;
    if (!did || !urlKey(url)) return;
    // From storage, not the cached list, so another tab's reads aren't
    // overwritten by this one's older copy.
    const current = load(did) ?? byDid[did] ?? [];
    const cleanTitle = title?.trim() || undefined;
    const now = Date.now();
    const head = current[0];
    if (
      head &&
      sameArticle(head.url, url) &&
      head.title === cleanTitle &&
      now - head.at < REFRESH_AFTER_MS
    ) {
      return;
    }
    const next = [
      { url, title: cleanTitle, at: now },
      ...current.filter((entry) => !sameArticle(entry.url, url)),
    ].slice(0, CAP);
    byDid[did] = next;
    try {
      localStorage.setItem(KEY_PREFIX + did, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the suggestion lasts for this tab only.
    }
  }

  return {
    /** Newest first, for the signed-in reader. */
    get entries() {
      return list();
    },
    record,
  };
}

export const recentReadsStore = createRecentReadsStore();
