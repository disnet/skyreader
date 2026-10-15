/**
 * A saved EPUB's text, made whole for the reader. The backend stores a book's
 * pictures as references into the kept original (`<img data-epub-src="path">`,
 * see backend/src/services/epub.ts) and scopes its own links to anchors in the
 * joined text (`#epub-c3-note12`). These fill in the pictures' addresses and
 * find the place a book link points at.
 */

// The attribute value as DOMPurify serialises it: `&`, `"`, `<`, `>` escaped.
function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Give each picture in sanitized book HTML its `src`: `assetUrl(path)` (the
 * owner-only GET /api/saved/<rkey>/asset). Run after sanitizing, so the
 * address is ours, not the book's.
 */
export function resolveEpubImages(html: string, assetUrl: (path: string) => string): string {
  return keepEpubLinksInPlace(
    html.replace(
      /<img\b([^>]*?)\sdata-epub-src="([^"]*)"/g,
      (_all, before: string, path: string) =>
        `<img${before} src="${encodeAttribute(assetUrl(decodeAttribute(path)))}" data-epub-src="${path}"`
    )
  );
}

/**
 * The sanitizer opens every link in a new tab. A book's own links are places in
 * this text, so they stay plain hash links: a click the footnote jump doesn't
 * take moves within this page, and one opened elsewhere (a middle click, the
 * context menu) is this reader's own URL at that anchor.
 */
function keepEpubLinksInPlace(html: string): string {
  return html.replace(/<a\b[^>]*\shref="#epub-c\d+[^"]*"[^>]*>/g, (tag) =>
    tag.replace(/\s(?:target|rel)="[^"]*"/g, '')
  );
}

/** Whether a link's href is one of a book's own anchors. */
export function isEpubAnchorHref(href: string | null): href is string {
  return Boolean(href && /^#epub-c\d+/.test(href));
}

/** The element a book link points at, inside `root`. */
export function findEpubAnchor(root: ParentNode, href: string): HTMLElement | null {
  // The backend scopes ids to word characters and dashes (epubAnchorId); anything
  // else is no anchor of ours.
  const id = href.slice(1);
  if (!/^[\w-]+$/.test(id)) return null;
  return root.querySelector<HTMLElement>(`[id="${id}"]`);
}
