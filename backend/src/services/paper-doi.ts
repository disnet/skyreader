// The DOI to say a page is, where Skyreader writes or asks about it publicly:
// a Semble card's `metadata.doi`, and the community-highlights lookup. From the
// URL when it names one, else the DOI the reader's save of the page declared.

import type { Env } from '../types';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { exactDoi, idsFromUrl } from './export/identifiers';

/** The DOI the reader's save of this page declared in its <head>, if they saved it. Best-effort. */
export async function savedDoiFor(env: Env, did: string, url: string): Promise<string | null> {
  const normalized = normalizeArticleUrl(url);
  if (!normalized) return null;
  try {
    const row = await env.DB.prepare(
      'SELECT doi FROM saved_articles WHERE user_did = ? AND url_normalized = ? AND doi IS NOT NULL'
    )
      .bind(did, normalized)
      .first<{ doi: string }>();
    return exactDoi(row?.doi) ?? null;
  } catch {
    return null;
  }
}

/** A page's DOI for a card: the URL's own, else a declared one. */
export function pageDoi(url: string, declared?: string | null): string | undefined {
  return idsFromUrl(url).doi ?? exactDoi(declared);
}
