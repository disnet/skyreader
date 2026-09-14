// Reactive fixtures for `feedViewPendingChannel.component.test.ts`.
//
// The whole point of that test is a channel that is absent when the URL is read
// and present a moment later — so the stand-in channel store has to be reactive.
// feedView resolves `?view=` through a `$derived`, and a plain module array is
// read once and cached, which would hide exactly the transition under test.
// `$state` lives in a `.svelte.ts` module, hence this file.
import type { FilteredView } from '$lib/types';

export const channels = $state({
  /** What `filteredViewsStore.views` reports. Starts empty — the cold load. */
  list: [] as FilteredView[],
  /** Every `filteredViewsStore.update()` the store under test issued. */
  updates: [] as Array<{ id: number; changes: Partial<FilteredView> }>,
});

export function resetChannels() {
  channels.list = [];
  channels.updates = [];
}
