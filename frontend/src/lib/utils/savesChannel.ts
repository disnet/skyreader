// A channel that reads only the reader's saves. There's one kind of channel; a
// channel whose only source is Your saves opens as the Library does (Inbox /
// Archive, the save filters and sorts), and is what the old Saved channel type
// becomes (foldSavedChannel).

import type { FilteredView } from '$lib/types';
import { CHANNEL_FILTER_VERSION } from './sourceFilter';

type SavesChannelFields = Pick<
  FilteredView,
  'mode' | 'query' | 'sourceMode' | 'sourceKeys' | 'librarySources' | 'autoRule'
>;

/** Whether the channel reads your saves and nothing else (not a saved search). */
export function isSavesChannel(view: SavesChannelFields | null | undefined): boolean {
  if (!view) return false;
  if (view.mode === 'saved') return true;
  return (
    !view.query?.trim() &&
    !view.autoRule &&
    view.sourceMode === 'include' &&
    (view.sourceKeys ?? []).length === 0 &&
    (view.librarySources ?? []).includes('saves')
  );
}

/**
 * An old Saved channel as the channel it now is: one that takes in Your saves
 * and no feeds. Its save filters, sort, tags and Inbox / Archive state carry
 * over as they were. Null for any other channel.
 */
export function foldSavedChannel(view: FilteredView): Partial<FilteredView> | null {
  if (view.mode !== 'saved') return null;
  return {
    mode: 'feed',
    sourceMode: 'include',
    sourceKeys: [],
    librarySources: ['saves'],
    filterVersion: CHANNEL_FILTER_VERSION,
    // A change like any edit, so the folded channel wins the sync.
    updatedAt: Date.now(),
  };
}
