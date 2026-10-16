import type { UrlFilters } from './urlFilters';

/**
 * The plain Everything river remembers its toolbar filters — sources and the
 * unread/all toggle — across reloads. A per-device convenience, so it lives in
 * localStorage. Channels persist their own filters; this covers only the river
 * that has no channel to save into. (Sort order there is the global preference,
 * which already persists.)
 *
 * Source keys are subscription rkeys and follow DIDs, which mean nothing to
 * another account, so the stored copy carries its owner and is ignored by
 * anyone else (a different account, or a guest on the same browser).
 */

const KEY = 'skyreader-everything-filters';

export interface EverythingFilters {
  sourceMode: 'all' | 'include' | 'exclude';
  sourceKeys: string[];
  showOnlyUnread: boolean;
}

interface Stored extends EverythingFilters {
  owner: string;
}

/** True when the URL selects the plain Everything river: no filter at all. */
export function isEverythingUrl(f: UrlFilters): boolean {
  return (
    f.feed == null &&
    f.saved == null &&
    f.sharer == null &&
    f.following == null &&
    f.feeds == null &&
    f.contentType == null &&
    f.view == null &&
    f.category == null
  );
}

/** The filters last left on Everything by `owner`, or null if none are stored. */
export function loadEverythingFilters(owner: string | null): EverythingFilters | null {
  if (!owner) return null;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const s = parsed as Partial<Stored>;
    if (s.owner !== owner) return null;
    if (s.sourceMode !== 'all' && s.sourceMode !== 'include' && s.sourceMode !== 'exclude') {
      return null;
    }
    const sourceKeys = Array.isArray(s.sourceKeys)
      ? s.sourceKeys.filter((k): k is string => typeof k === 'string')
      : [];
    return {
      sourceMode: s.sourceMode,
      sourceKeys: s.sourceMode === 'all' ? [] : sourceKeys,
      showOnlyUnread: s.showOnlyUnread !== false,
    };
  } catch {
    return null;
  }
}

/** Remember the filters `owner` just set on Everything. */
export function saveEverythingFilters(owner: string | null, filters: EverythingFilters): void {
  if (!owner) return;
  const stored: Stored = {
    owner,
    sourceMode: filters.sourceMode,
    sourceKeys: filters.sourceMode === 'all' ? [] : [...filters.sourceKeys],
    showOnlyUnread: filters.showOnlyUnread,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Private mode or storage full: the filters last until the next reload.
  }
}
