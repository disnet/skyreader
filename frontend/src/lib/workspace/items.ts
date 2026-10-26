// What Skyreader tells the workspace shell about its items, worked out from
// plain data so it can be tested without the stores: the item being read, the
// unread count for the badge, and "what links here" for an item another app is
// showing. The bridge ($lib/workspace/bridge.svelte.ts) feeds these the stores.

import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import type { Article, FilteredView, Highlight, SavedItem, SocialDocument } from '$lib/types';
import { urlKey } from '$lib/utils/urlKey';
import { cleanItem, isAtUri, type WorkspaceItem } from './protocol';

/** The item for a reader item: its web page, and its record if it has one. */
export function itemForReader(item: FeedDisplayItem, title: string): WorkspaceItem {
  switch (item.type) {
    case 'article':
      return cleanItem({ title, url: item.item.url });
    case 'document':
      return cleanItem({ title, uri: item.item.recordUri, url: item.item.canonicalUrl });
    case 'saved':
      // A save's own uri names a Skyreader row, not a record anyone can open;
      // a saved document carries its record's uri as its guid.
      return cleanItem({ title, uri: item.item.itemGuid, url: item.item.url });
  }
}

/**
 * The badge: unread across the channels the reader marked as worth a nudge.
 * A post in two such channels counts twice; channel counts are all there is.
 */
export function nudgeCount(views: FilteredView[], counts: Map<number, number>): number {
  let total = 0;
  for (const view of views) {
    if (view.nudge && view.id != null) total += counts.get(view.id) ?? 0;
  }
  return total;
}

export interface ContextSources {
  /** A save by its guid or URL (`savesStore.find`). */
  findSave: (guidOrUrl: string) => SavedItem | undefined;
  /** Feed items held on this device. */
  articles: Article[];
  feedTitle: (subscriptionId: number) => string | undefined;
  documents: SocialDocument[];
  /** An item's highlights by any of its keys (`itemLabelsStore.getHighlights`). */
  highlightsFor: (itemKey: string) => Highlight[];
  /** Every highlight, for those found by the page they were made on. */
  allHighlights: { highlight: Highlight }[];
}

const MAX_HIGHLIGHTS = 10;
const EXCERPT = 160;

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
};

const sameUrl = (key: string | null, url: string | null | undefined) =>
  !!key && !!url && urlKey(url) === key;

/**
 * What Skyreader has about `item`: the save, the feed it came in on, and the
 * reader's highlights on it. Matched by record uri, or by the page's URL as
 * `urlKey` spells it, so a tracking parameter or a trailing slash doesn't hide
 * a match.
 */
export function contextFor(item: WorkspaceItem, sources: ContextSources): WorkspaceItem[] {
  const key = item.url ? urlKey(item.url) : null;
  const uri = isAtUri(item.uri) ? item.uri : undefined;
  if (!key && !uri) return [];

  const save = (uri && sources.findSave(uri)) || (item.url && sources.findSave(item.url)) || null;
  const article =
    sources.articles.find((a) => (uri && a.guid === uri) || sameUrl(key, a.url)) ?? null;
  const doc =
    sources.documents.find((d) => (uri && d.recordUri === uri) || sameUrl(key, d.canonicalUrl)) ??
    null;

  const base = cleanItem({
    title: save?.title || article?.title || doc?.title || item.title,
    uri: uri ?? doc?.recordUri ?? save?.itemGuid,
    url: item.url ?? save?.url ?? article?.url ?? doc?.canonicalUrl,
  });

  const out: WorkspaceItem[] = [];
  if (save) out.push({ ...base, text: 'Saved in Skyreader' });
  if (article) {
    const feed = sources.feedTitle(article.subscriptionId);
    out.push({ ...base, text: feed ? `In your feeds · ${feed}` : 'In your feeds' });
  } else if (doc) {
    out.push({ ...base, text: 'In your feeds' });
  }

  const keys = new Set(
    [uri, save?.itemGuid, save?.uri, save?.rkey, article?.guid, doc?.recordUri, item.url].filter(
      (k): k is string => !!k
    )
  );
  const seen = new Set<string>();
  const highlights: Highlight[] = [];
  const take = (h: Highlight) => {
    if (seen.has(h.id)) return;
    seen.add(h.id);
    highlights.push(h);
  };
  for (const k of keys) sources.highlightsFor(k).forEach(take);
  if (key) {
    for (const { highlight } of sources.allHighlights) {
      if (sameUrl(key, highlight.sourceUrl)) take(highlight);
    }
  }
  highlights.sort((a, b) => b.createdAt - a.createdAt);
  for (const h of highlights.slice(0, MAX_HIGHLIGHTS)) {
    const quote = excerpt(h.selector.exact);
    out.push({
      ...base,
      title: 'Your highlight',
      text: h.note ? `${quote} · ${excerpt(h.note)}` : quote,
    });
  }
  return out;
}
