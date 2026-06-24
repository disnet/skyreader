// Canonical paths for the reading surfaces. The app used to live entirely at `/`
// with query params; it now has real routes: /home (landing), /feeds (the river,
// formerly "Everything"), and /saved. Sub-filters (a single feed, a category, a
// channel, the shared view) still ride as query params on whichever base.
import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';

export const FEEDS_PATH = '/feeds';
export const SAVED_PATH = '/saved';

/** A single subscription's feed view. */
export function feedPath(id: string | number): string {
  return `${FEEDS_PATH}?feed=${id}`;
}

/** A category group. */
export function categoryPath(name: string): string {
  return `${FEEDS_PATH}?category=${encodeURIComponent(name)}`;
}

/**
 * A channel (FilteredView), routed by its mode: saved channels live under /saved,
 * feed channels under /feeds. Accepts a uuid or a numeric id (the latter is what
 * `create()` returns). Falls back to /feeds when the view can't be resolved yet.
 */
export function channelPath(idOrUuid: string | number): string {
  const view =
    typeof idOrUuid === 'number'
      ? filteredViewsStore.getById(idOrUuid)
      : (filteredViewsStore.getByUuid(idOrUuid) ?? filteredViewsStore.getById(Number(idOrUuid)));
  const base = view?.mode === 'saved' ? SAVED_PATH : FEEDS_PATH;
  return `${base}?view=${view?.uuid ?? idOrUuid}`;
}
