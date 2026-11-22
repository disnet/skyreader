// Every link an article points to, for the "All links in this article" control
// at the end of the reader: pages one could save, each once, in reading order.
import { urlKey } from '$lib/utils/urlKey';

export interface ArticleLink {
  url: string;
  /** The link's own words, collapsed; empty for an image-only link. */
  text: string;
}

// A link straight to a picture, a sound, a video or an archive is not a page to
// read (a gallery's lightbox links are the common case). A PDF is: it saves.
const NOT_A_PAGE =
  /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic|ico|mp3|m4a|wav|ogg|flac|mp4|m4v|mov|webm|avi|zip|gz|tgz|rar|7z|dmg|exe)$/i;

/** A page's key with its scheme and `www.` set aside, to tell "the same site" apart loosely. */
function looseKey(url: string): string | null {
  const key = urlKey(url);
  return key ? key.replace(/^https?:\/\/(?:www\.)?/, '') : null;
}

/** Text that reads as a title for a link: not a bare URL, not "here" or "this". */
export function linkTitleHint(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 12 || /^(https?:\/\/|www\.)/i.test(t)) return undefined;
  return t;
}

/**
 * The links in `root` (an article's rendered body), resolved against the
 * article's own address when it has one. Leaves out anything that isn't a web
 * page (mail, in-page jumps, scripts, pictures and other files), links back to
 * the article itself (footnotes, a permalink, the same page over http or
 * without www), and repeats of a page already listed, keeping the first
 * link's words, or the first that has words.
 */
export function articleLinks(root: ParentNode, articleUrl?: string | null): ArticleLink[] {
  let base: URL | undefined;
  try {
    base = articleUrl ? new URL(articleUrl) : undefined;
  } catch {
    base = undefined;
  }
  const self = base ? looseKey(base.href) : null;
  const byKey = new Map<string, ArticleLink>();
  for (const a of root.querySelectorAll('a[href]')) {
    let parsed: URL;
    try {
      parsed = new URL(a.getAttribute('href') ?? '', base);
    } catch {
      continue;
    }
    if (NOT_A_PAGE.test(parsed.pathname)) continue;
    const url = parsed.href;
    const key = urlKey(url);
    if (!key || looseKey(url) === self) continue;
    const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { url, text });
    else if (!seen.text && text) seen.text = text;
  }
  return [...byKey.values()];
}
