import {
  api,
  ExtractionBlockedError,
  OfflineError,
  SessionExpiredError,
  type ExtractedArticle,
} from '$lib/services/api';
import { reportClientError } from '$lib/services/telemetry';
import { docsUrl } from '$lib/constants/docs';
import { escapeHtml } from '$lib/utils/html';
import type { RoomItem, SavedItem } from '$lib/types';

// Opening a room article never saves it: the reader gets a synthetic SavedItem
// built from the stateless /api/extract (rkey '' skips the saves store's lazy
// body fetch, and nothing lands in D1). An article that can't be fetched still
// opens in the reader, as a note linking the page. Shared by the room page and the Home
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

/** A synthetic, unsaved SavedItem for the reader: `rkey: ''` skips the saves
 *  store's lazy body fetch, and nothing lands in D1. Extraction's fields win;
 *  the surface's own metadata fills the gaps. */
function readerItemFor(
  ref: ArticleRef,
  content: string,
  extracted: ExtractedArticle | null = null
): SavedItem {
  return {
    rkey: '',
    uri: '',
    url: ref.url,
    title: extracted?.title ?? ref.title ?? null,
    author: extracted?.author ?? ref.author ?? null,
    description: extracted?.description ?? ref.description ?? null,
    content,
    contentType: null,
    domain: extracted?.domain ?? roomItemDomain(ref.url),
    image: extracted?.image ?? ref.image ?? null,
    wordCount: extracted?.wordCount ?? null,
    publishedAt: extracted?.published ?? null,
    savedAt: new Date().toISOString(),
    source: 'url',
  };
}

/** Extract the article body for the reader. Null = no body came back; the
 *  caller should fall back to opening the URL directly. The follows-links
 *  surface opens articles this way, without saving them. */
export async function extractArticle(ref: ArticleRef): Promise<SavedItem | null> {
  const extracted = await api.extract(ref.url).catch(() => null);
  if (!extracted?.content) return null;
  return readerItemFor(ref, extracted.content, extracted);
}

/** Why an article couldn't be fetched for the reader. */
export type ArticleOpenFailure = 'blocked' | 'offline' | 'failed';

function openFailure(err: unknown): ArticleOpenFailure {
  if (err instanceof ExtractionBlockedError) return 'blocked';
  if (
    err instanceof OfflineError ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  ) {
    return 'offline';
  }
  return 'failed';
}

/**
 * What the reader shows in place of an article it couldn't fetch: what happened
 * and a link to the page itself. The link is tapped inside the reader, so it
 * opens on a fresh gesture that no popup blocker refuses.
 */
export function articleOpenFailedBody(url: string, reason: ArticleOpenFailure): string {
  const host = roomItemDomain(url)?.replace(/^www\./, '') ?? url;
  const why =
    reason === 'blocked'
      ? "Skyreader couldn't fetch this article: the site blocks automated readers."
      : reason === 'offline'
        ? "You're offline, so Skyreader couldn't fetch this article."
        : "Skyreader couldn't fetch this article.";
  const link = (href: string, text: string) =>
    `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  return [
    `<p>${why}</p>`,
    `<p>${link(url, `Read it on ${host}`)}</p>`,
    ...(reason === 'blocked'
      ? [`<p>${link(docsUrl('siteBlocksSaving'), "When a site won't let Skyreader read it")}</p>`]
      : []),
  ].join('\n');
}

/**
 * A reader item for a link, always. When extraction fails the reader still
 * opens, on the metadata the surface already holds plus a note linking the page,
 * rather than bouncing out to a browser tab (which an installed PWA shows as a
 * separate browser, and which a popup blocker may refuse outright after the
 * await). Unexpected failures are reported, so a broken extract path shows up in
 * Sentry rather than as tabs nobody asked for.
 */
export async function articleForReader(ref: ArticleRef): Promise<SavedItem> {
  let failure: ArticleOpenFailure;
  try {
    const extracted = await api.extract(ref.url);
    if (extracted?.content) return readerItemFor(ref, extracted.content, extracted);
    failure = 'failed';
    reportClientError('article_open_failed', new Error('article open failed: empty extraction'));
  } catch (err) {
    failure = openFailure(err);
    // A site's own block is expected, offline isn't about us, and an expired
    // session signs the reader out on its own; anything else is worth knowing.
    // No URL or domain in the report: which articles someone reads is exactly
    // what the reporter never sends. The error's name and status say enough.
    if (failure === 'failed' && !(err instanceof SessionExpiredError)) {
      const name = err instanceof Error ? err.name : 'Error';
      const status = (err as { status?: unknown } | null)?.status;
      reportClientError(
        'article_open_failed',
        new Error(`article open failed: ${name}${typeof status === 'number' ? ` ${status}` : ''}`)
      );
    }
  }
  return readerItemFor(ref, articleOpenFailedBody(ref.url, failure));
}

/** A room article for the reader (see articleForReader). */
export function roomArticleForReader(item: RoomItem): Promise<SavedItem> {
  return articleForReader(item);
}
