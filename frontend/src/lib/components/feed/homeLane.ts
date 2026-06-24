import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';

// The view-model for one Home lane tile. HomePage builds these from saved items +
// read state so HomeLane / HomeLaneCard stay purely presentational.
export interface LaneCardVM {
  key: string;
  displayItem: FeedDisplayItem;
  title: string;
  domain: string | null;
  image: string | null;
  faviconUrl: string;
  /** "6 min left" for in-progress, "8 min read" otherwise, or null when unknown. */
  metaLabel: string | null;
  /** 0–1 reading progress; drives the spine bar on the Continue reading lane. */
  progress: number | null;
}
