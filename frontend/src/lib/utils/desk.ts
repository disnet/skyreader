// The Desk: the few pieces a reader has open in one sitting, to flip between.
//
// Pure list logic, kept apart from the store (`stores/desk.svelte.ts`) so it's
// tested without Svelte. A Desk entry names a reader item by its display key
// (the `?read=` key) and carries just enough to draw a row while the item itself
// isn't loaded: its title, its source, and the keys its reading position may be
// filed under (`readProgressKeys`), so a row can show how far through it is.

/** How many pieces fit on the Desk. A sitting, not a second queue. */
export const DESK_LIMIT = 6;

/** What a full Desk says when asked to take one more. */
export const DESK_FULL_LINE = `The Desk holds ${DESK_LIMIT}. Take one off first.`;

/** How many recently opened pieces to remember, for the back-and-forth toggle. */
const RECENT_LIMIT = 2;

export interface DeskEntry {
  key: string;
  title: string;
  source: string;
  /** Every key the item's `readProgress` may live under; `[key]` at the least. */
  progressKeys: string[];
  /**
   * Put on the Desk already read through or archived (re-reading, or working
   * from the Archive), so being done doesn't take it off again.
   */
  stays?: boolean;
}

const STORAGE_PREFIX = 'skyreader-desk:';

/** Where an account's Desk is kept on this device. */
export function deskStorageKey(owner: string): string {
  return STORAGE_PREFIX + owner;
}

/** Forget every account's Desk on this device (signing out clears local data). */
export function clearStoredDesks() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // No storage to clear.
  }
}

export interface DeskState {
  /** Pieces put on the Desk, in the order they were put there. */
  entries: DeskEntry[];
  /** Pieces opened in the reader, most recent first. */
  recent: DeskEntry[];
}

export const EMPTY_DESK: DeskState = { entries: [], recent: [] };

/** Add `entry`, or refresh its title and source when it's already there. Null when full. */
export function addToDesk(state: DeskState, entry: DeskEntry): DeskState | null {
  const at = state.entries.findIndex((e) => e.key === entry.key);
  if (at >= 0) {
    const entries = [...state.entries];
    entries[at] = { ...entry, stays: entry.stays || state.entries[at].stays };
    return { ...state, entries };
  }
  if (state.entries.length >= DESK_LIMIT) return null;
  return { ...state, entries: [...state.entries, entry] };
}

export function removeFromDesk(state: DeskState, key: string): DeskState {
  if (!state.entries.some((e) => e.key === key)) return state;
  return { ...state, entries: state.entries.filter((e) => e.key !== key) };
}

/**
 * Note that `entry` is now open in the reader. It moves to the front of the
 * recent list, and a Desk entry for the same key picks up its fresher title.
 */
export function noteOpened(state: DeskState, entry: DeskEntry): DeskState {
  if (state.recent[0]?.key === entry.key && sameEntry(state.recent[0], entry)) return state;
  const recent = [entry, ...state.recent.filter((e) => e.key !== entry.key)].slice(0, RECENT_LIMIT);
  const at = state.entries.findIndex((e) => e.key === entry.key);
  if (at < 0) return { ...state, recent };
  const entries = [...state.entries];
  entries[at] = { ...entry, stays: state.entries[at].stays };
  return { entries, recent };
}

/** The piece open before `currentKey`, for the toggle: null when there's none. */
export function previousPiece(state: DeskState, currentKey: string): DeskEntry | null {
  return state.recent.find((e) => e.key !== currentKey) ?? null;
}

function sameEntry(a: DeskEntry, b: DeskEntry): boolean {
  return (
    a.key === b.key &&
    a.title === b.title &&
    a.source === b.source &&
    a.progressKeys.length === b.progressKeys.length &&
    a.progressKeys.every((k, i) => k === b.progressKeys[i])
  );
}

function isEntry(v: unknown): v is DeskEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.key === 'string' &&
    e.key.length > 0 &&
    typeof e.title === 'string' &&
    typeof e.source === 'string' &&
    Array.isArray(e.progressKeys) &&
    e.progressKeys.every((k) => typeof k === 'string') &&
    (e.stays === undefined || typeof e.stays === 'boolean')
  );
}

/** Read a stored Desk back, dropping anything malformed rather than failing. */
export function parseDesk(raw: unknown): DeskState {
  if (!raw || typeof raw !== 'object') return EMPTY_DESK;
  const r = raw as Record<string, unknown>;
  const entries = Array.isArray(r.entries) ? r.entries.filter(isEntry) : [];
  const recent = Array.isArray(r.recent) ? r.recent.filter(isEntry) : [];
  const seen = new Set<string>();
  return {
    entries: entries
      .filter((e) => !seen.has(e.key) && (seen.add(e.key), true))
      .slice(0, DESK_LIMIT),
    recent: recent.slice(0, RECENT_LIMIT),
  };
}
