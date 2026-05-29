import { api, type ExtractedArticle } from '$lib/services/api';

export type { ExtractedArticle };

/**
 * Extract article content for a URL. The fetch + Defuddle extraction (and the
 * date validation) now happen on the feed proxy, which caches results per URL.
 */
export function extractArticle(url: string): Promise<ExtractedArticle> {
  return api.extract(url);
}
