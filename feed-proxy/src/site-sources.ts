// Pages whose text isn't in their HTML. Some sites render an article in the
// browser from a JSON API, so the page a fetch gets is an empty app shell and
// Defuddle finds nothing to extract. For those we know where the text lives:
// each source maps a page URL to the URL that serves its text, and turns that
// response back into an HTML document for the ordinary extractor.

export interface SiteSource {
  /** Where the page's text is served from. */
  url: string;
  /** Accept header for that request. */
  accept: string;
  /** The response body as an HTML document, or null when it holds no article. */
  toHtml(body: string): string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

// attie.ai pages (`/@handle/pages/<uuid>`) are a Next.js shell; the client
// fetches the page itself from `/api/shared-pages/<uuid>`, which answers a
// public page without a session: `{ title, html, owner: { handle },
// published_at, visibility, … }`. A private page answers an error and falls
// through to the ordinary fetch.
const ATTIE_PAGE_RE =
  /^\/@[^/]+\/pages\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

function attieSource(url: URL): SiteSource | null {
  if (url.hostname !== 'attie.ai' && url.hostname !== 'www.attie.ai') return null;
  const match = ATTIE_PAGE_RE.exec(url.pathname);
  if (!match) return null;
  return {
    url: `https://attie.ai/api/shared-pages/${match[1]}`,
    accept: 'application/json',
    toHtml(body) {
      let page: Record<string, unknown>;
      try {
        page = JSON.parse(body);
      } catch {
        return null;
      }
      const raw = str(page?.html);
      if (!raw) return null;
      const html = raw
        // The page's lead (headline + dek) sits in a <header>, which Defuddle
        // strips as page chrome.
        .replace(/<(\/?)header\b/gi, '<$1div')
        // Bluesky embeds are empty custom elements the browser hydrates; keep
        // each as a link to the post rather than lose it.
        .replace(
          /<bsky-post\b[^>]*\buri="at:\/\/([^/"]+)\/app\.bsky\.feed\.post\/([^/"]+)"[^>]*>\s*<\/bsky-post>/gi,
          (_m, did: string, rkey: string) =>
            `<p><a href="https://bsky.app/profile/${escapeHtml(did)}/post/${escapeHtml(rkey)}">View the post on Bluesky</a></p>`
        );
      const title = str(page.title);
      const owner = page.owner as Record<string, unknown> | undefined;
      const author = str(owner?.handle);
      const published = str(page.published_at) ?? str(page.created_at);
      const head = [
        title && `<title>${escapeHtml(title)}</title>`,
        author && `<meta name="author" content="${escapeHtml(author)}">`,
        published && `<meta property="article:published_time" content="${escapeHtml(published)}">`,
      ]
        .filter(Boolean)
        .join('');
      return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body><article>${html}</article></body></html>`;
    },
  };
}

/** The source of a page's text when it isn't in the page's HTML; null otherwise. */
export function siteSourceFor(rawUrl: string): SiteSource | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  return attieSource(url);
}
