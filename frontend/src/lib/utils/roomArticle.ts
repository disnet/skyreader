import { api } from '$lib/services/api';
import type { RoomItem, SavedItem } from '$lib/types';

// Opening a room article never saves it: the reader gets a synthetic SavedItem
// built from the stateless /api/extract (rkey '' skips the saves store's lazy
// body fetch, and nothing lands in D1). Shared by the room page and the Home
// room lanes so both surfaces open articles identically.
// See docs/plans/READING_ROOMS_SPIKE.md.

export function roomItemDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Extract the article body for the reader. Null = no body came back; the
 *  caller should fall back to opening the URL directly. */
export async function extractRoomArticle(item: RoomItem): Promise<SavedItem | null> {
  const extracted = await api.extract(item.url).catch(() => null);
  if (!extracted?.content) return null;
  return {
    rkey: '',
    uri: '',
    url: item.url,
    title: extracted.title ?? item.title ?? null,
    author: extracted.author ?? item.author ?? null,
    description: extracted.description ?? item.description ?? null,
    content: extracted.content,
    contentType: null,
    domain: extracted.domain ?? roomItemDomain(item.url),
    image: extracted.image ?? item.image ?? null,
    wordCount: extracted.wordCount ?? null,
    publishedAt: extracted.published ?? null,
    savedAt: new Date().toISOString(),
    source: 'url',
  };
}
