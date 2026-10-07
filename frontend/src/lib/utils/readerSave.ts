// Save/Unsave for a reader item that *is* a save.
//
// A `?read=` restore resolves saves first (`readerLink.ts`), so an article you
// saved on `/feeds` — or a linkblog post you saved — comes back typed `'saved'`
// rather than `'article'`/`'document'` whenever the URL is what opened it: a
// reload, a Forward-reopen, a link from another device. The reader's Save
// control has to keep working on those surfaces, and the save row is the only
// handle it has, so it acts on the save directly instead of on the feed article
// or document behind it.
//
// Identity is the save's guid or URL, never its display key: that key is usually
// the save's `at://` record uri (`savedItemDisplayKey`), which the store's
// lookup maps don't index — asking `savesStore.isSaved` about it answers "not
// saved" for an item that plainly is.
import { savesStore } from '$lib/stores/saves.svelte';
import type { SavedItem } from '$lib/types';

/**
 * The live row for `save`, or undefined once it's been unsaved. Reactive: it
 * reads the store's lookup maps, which are rebuilt on every mutation.
 */
function liveSave(save: SavedItem): SavedItem | undefined {
  const byGuid = save.itemGuid ? savesStore.getByGuid(save.itemGuid) : undefined;
  return byGuid ?? (save.url ? savesStore.getByUrl(save.url) : undefined);
}

/** Whether a `'saved'` reader item is still saved — the reader's button label. */
export function isSavedItemSaved(save: SavedItem): boolean {
  return liveSave(save) !== undefined;
}

// The body of the last save unsaved through here. A document save stores its
// rendered body and has no URL to re-extract from, so undoing a mis-tapped
// Unsave would otherwise bring the item back empty. One slot: only the undo of
// the thing you just did needs it.
let lastUnsavedBody: { guid: string; content: string | null } | null = null;

/**
 * Toggle the save behind a `'saved'` reader item. Unsaves the *live* row rather
 * than the one the reader is holding, so a save → unsave → save round trip in a
 * single reading session still removes the right record (re-saving mints a new
 * rkey, and the reader's copy keeps the old one).
 */
export async function toggleSavedItemSave(save: SavedItem): Promise<void> {
  const live = liveSave(save);
  if (live) {
    const guid = live.itemGuid || live.url;
    const content = live.source === 'document' ? await savesStore.getContent(live.rkey) : null;
    await savesStore.remove(live.rkey);
    lastUnsavedBody = { guid, content };
    return;
  }

  // A standard.site document renders from its record, not from URL extraction —
  // re-save it as one, under the record uri its guid already is.
  if (save.source === 'document' && save.itemGuid) {
    const guid = save.itemGuid;
    await savesStore.saveDocument({
      recordUri: guid,
      url: save.url,
      title: save.title ?? undefined,
      description: save.description ?? undefined,
      publishedAt: save.publishedAt ?? undefined,
      content:
        save.content ??
        (lastUnsavedBody?.guid === guid ? (lastUnsavedBody.content ?? undefined) : undefined),
    });
    return;
  }

  await savesStore.saveArticle({
    url: save.url,
    // Re-save under the same guid the original carried, so the feed article it
    // came from lights up as saved again (the list matches on guid).
    guid: save.itemGuid || save.url,
    title: save.title ?? undefined,
    author: save.author ?? undefined,
    summary: save.description ?? undefined,
    imageUrl: save.image ?? undefined,
    publishedAt: save.publishedAt ?? undefined,
  });
}
