import { api } from '$lib/services/api';
import type { RoomItem, SavedItem } from '$lib/types';

// Opening a room article never saves it: the reader gets a synthetic SavedItem
// built from the stateless /api/extract (rkey '' skips the saves store's lazy
// body fetch, and nothing lands in D1). Shared by the room page and the Home
// room lanes so both surfaces open articles identically.
// See docs/plans/READING_ROOMS_SPIKE.md.

/**
 * Reading order for a room's list: what you haven't read yet, oldest addition
 * first — the order the room was built in, so a list read top to bottom follows
 * its curator. Marking something read drops it below the unread pile rather than
 * hiding it. A member whose membership record carries no timestamp sorts last
 * within its group rather than claiming to be the oldest.
 *
 * The backend already returns items in this order, but both surfaces (room page,
 * Home lane) re-sort live as `readByMe` flips, so the rule lives here where they
 * share it.
 */
export function sortRoomItems<T extends Pick<RoomItem, 'readByMe' | 'addedAt'>>(items: T[]): T[] {
  const at = (i: T) => (i.addedAt ? Date.parse(i.addedAt) : Number.POSITIVE_INFINITY);
  return [...items].sort((a, b) => Number(a.readByMe) - Number(b.readByMe) || at(a) - at(b));
}

export function roomItemDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** The metadata a surface already holds for a link, used where extraction
 *  doesn't return a field. */
export interface ArticleRef {
  url: string;
  title?: string | null;
  author?: string | null;
  description?: string | null;
  image?: string | null;
}

/** Extract the article body for the reader. Null = no body came back; the
 *  caller should fall back to opening the URL directly. Rooms and the
 *  follows-links surface both open articles this way, without saving them. */
export async function extractArticle(ref: ArticleRef): Promise<SavedItem | null> {
  const extracted = await api.extract(ref.url).catch(() => null);
  if (!extracted?.content) return null;
  return {
    rkey: '',
    uri: '',
    url: ref.url,
    title: extracted.title ?? ref.title ?? null,
    author: extracted.author ?? ref.author ?? null,
    description: extracted.description ?? ref.description ?? null,
    content: extracted.content,
    contentType: null,
    domain: extracted.domain ?? roomItemDomain(ref.url),
    image: extracted.image ?? ref.image ?? null,
    wordCount: extracted.wordCount ?? null,
    publishedAt: extracted.published ?? null,
    savedAt: new Date().toISOString(),
    source: 'url',
  };
}

/** Extract a room article for the reader (see extractArticle). */
export function extractRoomArticle(item: RoomItem): Promise<SavedItem | null> {
  return extractArticle(item);
}
