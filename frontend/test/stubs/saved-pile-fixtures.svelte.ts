// Reactive fixtures for `savedPileConsistency.component.test.ts`.
//
// feedView's saved-list pipeline is a chain of `$derived` values, so a plain
// module-level array behind a stand-in store is read once and cached forever —
// every case after the first would assert against the previous case's list.
// `$state` lives in a `.svelte.ts` module, which is why this sits here rather
// than in the test file.
import type { Article, FilteredView, SavedItem, SocialDocument } from '$lib/types';

export const fixtures = $state({
  saves: [] as SavedItem[],
  articles: [] as Article[],
  documents: [] as SocialDocument[],
  archived: [] as string[],
  /** The saved channel `?view=` resolves to, when a case needs one. */
  channel: null as FilteredView | null,
});

export function resetFixtures() {
  fixtures.saves = [];
  fixtures.articles = [];
  fixtures.documents = [];
  fixtures.archived = [];
  fixtures.channel = null;
}
