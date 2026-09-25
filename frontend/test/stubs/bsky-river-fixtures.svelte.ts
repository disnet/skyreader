// Reactive fixtures for `feedViewBskyPosts.component.test.ts`: the stand-in
// stores feedView derives the river from, including the Bluesky feed pages.
// `$state`, so a change re-runs the derivations the way the real stores would.
import type { Article, BskyPost, FilteredView } from '$lib/types';

interface Page {
  posts: BskyPost[];
  cursor: string | null;
  loading: boolean;
  loaded: boolean;
  scopeRequired: boolean;
  error: string | null;
}

export const bskyRiver = $state({
  channels: [] as FilteredView[],
  articles: [] as Article[],
  pages: {} as Record<string, Page>,
  /** Every loadMore the river asked the store for, by feed uri. */
  loadMoreCalls: [] as string[],
});

export function resetBskyRiver() {
  bskyRiver.channels = [];
  bskyRiver.articles = [];
  bskyRiver.pages = {};
  bskyRiver.loadMoreCalls = [];
}

export function emptyPage(): Page {
  return {
    posts: [],
    cursor: null,
    loading: false,
    loaded: false,
    scopeRequired: false,
    error: null,
  };
}
