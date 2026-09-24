// Reactive fixtures for `feedViewFollowLinks.component.test.ts`: the stand-in
// stores feedView derives the river from. `$state`, so a change re-runs the
// derivations the way the real stores would (see pending-channel-fixtures).
import type { Article, FilteredView, FollowLink, SocialDocument } from '$lib/types';

export const river = $state({
  channels: [] as FilteredView[],
  articles: [] as Article[],
  documents: [] as SocialDocument[],
  links: [] as FollowLink[],
  read: [] as string[],
  /** followLinksStore.inEverything: null until the reader's been asked. */
  inEverything: null as boolean | null,
});

export function resetRiver() {
  river.channels = [];
  river.articles = [];
  river.documents = [];
  river.links = [];
  river.read = [];
  river.inEverything = null;
}
