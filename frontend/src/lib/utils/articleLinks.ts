// Every link an article points to, for the "All links in this article" control
// at the end of the reader: web pages only, each once, in reading order.
import { urlKey } from '$lib/utils/urlKey';

export interface ArticleLink {
  url: string;
  /** The link's own words, collapsed; empty for an image-only link. */
  text: string;
}

/**
 * The links in `root` (an article's rendered body), resolved against the
 * article's own address. Leaves out anything that isn't a web page (mail,
 * in-page jumps, scripts), links back to the article itself (footnotes,
 * a "permalink"), and repeats of a page already listed, keeping the first
 * link's words, or the first that has words.
 */
export function articleLinks(root: ParentNode, articleUrl?: string | null): ArticleLink[] {
  const self = articleUrl ? urlKey(articleUrl) : null;
  const byKey = new Map<string, ArticleLink>();
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    let url: string;
    try {
      url = new URL(href, articleUrl ?? undefined).href;
    } catch {
      continue;
    }
    const key = urlKey(url);
    if (!key || key === self) continue;
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { url, text });
    else if (!seen.text && text) seen.text = text;
  }
  return [...byKey.values()];
}
