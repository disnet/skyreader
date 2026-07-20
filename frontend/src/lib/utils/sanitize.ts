import DOMPurify from 'dompurify';

/**
 * Hosts allowed to be embedded via <iframe>. Only well-known video
 * providers are permitted; any other iframe is stripped during sanitization.
 */
const ALLOWED_IFRAME_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
]);

const VIDEO_IFRAME_ALLOW =
  'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';

function disableIframeAutoplay(url: URL): void {
  url.searchParams.set('autoplay', '0');

  // Vimeo's background mode implies autoplay + muted + loop with controls hidden.
  if (url.hostname.toLowerCase() === 'player.vimeo.com' && url.searchParams.get('background')) {
    url.searchParams.set('background', '0');
  }
}

/**
 * Returns the normalized (absolute, https) URL for a video iframe src if it
 * points at an allowed provider, or null if the iframe should be removed.
 */
export function allowedIframeSrc(src: string | null, base: URL | null): string | null {
  if (!src) return null;
  let url: URL;
  try {
    url = new URL(src, base ?? undefined);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!ALLOWED_IFRAME_HOSTS.has(url.hostname.toLowerCase())) return null;
  disableIframeAutoplay(url);
  return url.href;
}

/**
 * Returns `url` only if it is a navigable http(s) absolute URL, else undefined.
 *
 * Use at any `<a href>` sink fed by untrusted data — publication/document URLs
 * come straight from authors' PDS records, so a malicious author can supply a
 * `javascript:` / `data:` scheme that would execute on click. Binding the result
 * to `href` (which renders nothing for undefined) neutralizes that vector while
 * leaving real links intact.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') return url;
  } catch {
    /* not a valid absolute URL */
  }
  return undefined;
}

/** A base used for post-sanitize URL rewriting must itself be a web URL. */
export function safeSanitizerBase(baseUrl: string | null | undefined): URL | null {
  const navigableBase = safeHref(baseUrl);
  if (!navigableBase) return null;
  try {
    return new URL(navigableBase);
  } catch {
    return null;
  }
}

/**
 * Sanitizes HTML content, rewrites relative URLs to be absolute
 * based on the article's source URL, and opens all links in new tab.
 */
export function sanitizeHtml(html: string, baseUrl?: string): string {
  if (!html) return '';

  const base = safeSanitizerBase(baseUrl);

  // MathML: drop the annotation payloads outright. <semantics> pairs the
  // presentation markup the browser renders with alternate encodings of the
  // same expression, and MathJax/LaTeXML feeds (arXiv et al) ship a TeX
  // <annotation> next to every equation. DOMPurify would otherwise unwrap the
  // disallowed tag and keep its text, printing raw "a^2+b^2" beside the
  // rendered math. <annotation-xml> stays out of ADD_TAGS as well: with
  // encoding="text/html" it is an HTML integration point and a classic mXSS
  // namespace-confusion vector.
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'annotation' || data.tagName === 'annotation-xml') {
      node.parentNode?.removeChild(node);
    }
  });

  // Add hook to process URLs and links
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // Rewrite img src (only if we have a valid base)
    if (node.tagName === 'IMG') {
      // A daily issue can contain several full articles. Keep below-fold media
      // from competing with the text the reader is currently looking at.
      node.setAttribute('loading', 'lazy');
      node.setAttribute('decoding', 'async');

      if (base && node.hasAttribute('src')) {
        const src = node.getAttribute('src');
        if (src) {
          const absoluteUrl = resolveUrl(src, base);
          if (absoluteUrl) {
            node.setAttribute('src', absoluteUrl);
          }
        }
      }
    }

    // Rewrite srcset (only if we have a valid base)
    if (base && node.hasAttribute('srcset')) {
      const srcset = node.getAttribute('srcset');
      if (srcset) {
        const rewritten = rewriteSrcset(srcset, base);
        node.setAttribute('srcset', rewritten);
      }
    }

    // Process anchor tags: rewrite href and open in new tab
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      const href = node.getAttribute('href');
      if (href) {
        // Handle anchor-only links by pointing to original article
        if (href.startsWith('#') && base) {
          node.setAttribute('href', base.href + href);
        } else if (base) {
          const absoluteUrl = resolveUrl(href, base);
          if (absoluteUrl) {
            node.setAttribute('href', absoluteUrl);
          }
        }
      }
      // Open all links in new tab
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }

    // Rewrite video/audio src and poster (only if we have a valid base)
    if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
      node.removeAttribute('autoplay');
      node.setAttribute('preload', 'metadata');
    }

    if (
      base &&
      (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') &&
      node.hasAttribute('src')
    ) {
      const src = node.getAttribute('src');
      if (src) {
        const absoluteUrl = resolveUrl(src, base);
        if (absoluteUrl) {
          node.setAttribute('src', absoluteUrl);
        }
      }
    }
    if (base && node.tagName === 'VIDEO' && node.hasAttribute('poster')) {
      const poster = node.getAttribute('poster');
      if (poster) {
        const absoluteUrl = resolveUrl(poster, base);
        if (absoluteUrl) {
          node.setAttribute('poster', absoluteUrl);
        }
      }
    }

    // Rewrite source src (only if we have a valid base)
    if (base && node.tagName === 'SOURCE' && node.hasAttribute('src')) {
      const src = node.getAttribute('src');
      if (src) {
        const absoluteUrl = resolveUrl(src, base);
        if (absoluteUrl) {
          node.setAttribute('src', absoluteUrl);
        }
      }
    }

    // Only allow iframes from trusted video providers; strip all others.
    if (node.tagName === 'IFRAME') {
      const normalized = allowedIframeSrc(node.getAttribute('src'), base);
      if (!normalized) {
        node.remove();
        return;
      }
      node.setAttribute('src', normalized);
      node.setAttribute('loading', 'lazy');
      node.setAttribute('allow', VIDEO_IFRAME_ALLOW);
      node.setAttribute('allowfullscreen', '');
      node.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      // Drop fixed dimensions so the responsive CSS wrapper controls sizing.
      node.removeAttribute('width');
      node.removeAttribute('height');
      node.removeAttribute('style');
    }
  });

  const sanitized = DOMPurify.sanitize(html, {
    // <semantics> is a plain MathML container; allowing it keeps equations
    // well-formed now that the annotations inside are removed above. The rest
    // of MathML already survives via DOMPurify's default mathMl profile.
    ADD_TAGS: ['iframe', 'semantics'],
    ADD_ATTR: [
      'allow',
      'allowfullscreen',
      'frameborder',
      'referrerpolicy',
      'scrolling',
      // MathML accessibility hints publishers attach to <math>: a plain-text
      // rendering (alttext) and MathML-Core semantic intent. Both are inert
      // token strings — no URL or handler sink.
      'alttext',
      'intent',
      // <mtable> layout attributes that LaTeXML/MathJax emit for every aligned
      // equation, matrix, and cases block. DOMPurify's default MathML allowlist
      // omits these (it ships a legacy "columnsalign" that no engine emits),
      // so without them multi-line equations lose their alignment and collapse
      // to centered. All are enumerated layout tokens — safe on any element.
      'columnalign',
      'columnspacing',
      'columnwidth',
      'equalrows',
      'equalcolumns',
      'groupalign',
      'minlabelspacing',
      'side',
      'form',
    ],
    // Block attacker-supplied CSS: a feed can otherwise inject a <style> block or
    // inline style= to overlay/hide the app shell (clickjacking / content spoofing,
    // since the prod CSP allows 'unsafe-inline' styles). We rely on our own classes
    // for layout, never on styles carried in feed HTML.
    FORBID_TAGS: ['style'],
    FORBID_ATTR: ['style'],
  });

  // Remove hooks to avoid affecting other calls
  DOMPurify.removeHook('afterSanitizeAttributes');
  DOMPurify.removeHook('uponSanitizeElement');

  return sanitized;
}

/**
 * Resolves a URL against a base URL.
 * Returns the absolute URL or null if resolution fails.
 */
function resolveUrl(url: string, base: URL): string | null {
  // Skip data: and blob: URLs
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return null;
  }

  // Skip already absolute URLs
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return null;
  }

  // Skip javascript: and other protocol URLs
  if (url.includes(':')) {
    return null;
  }

  // Skip anchor-only links
  if (url.startsWith('#')) {
    return null;
  }

  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

/**
 * Rewrites srcset attribute to use absolute URLs.
 * Handles URLs that contain commas (like Cloudflare image URLs).
 */
function rewriteSrcset(srcset: string, base: URL): string {
  // Parse srcset entries. Each entry is a URL followed by whitespace and a descriptor.
  // Entries are separated by commas, but URLs can contain commas (e.g., /image/format=auto,width=500/photo.jpg).
  // The descriptor is a width (e.g., 500w) or pixel density (e.g., 2x).
  // We match: URL (anything), then whitespace, then descriptor, then comma or end.
  const entryRegex = /\s*(.+?)\s+(\d+(?:\.\d+)?[wx])\s*(?:,|$)/gi;

  const entries: string[] = [];
  let match;

  while ((match = entryRegex.exec(srcset)) !== null) {
    const url = match[1].trim();
    const descriptor = match[2];
    const absoluteUrl = resolveUrl(url, base) || url;
    entries.push(`${absoluteUrl} ${descriptor}`);
  }

  if (entries.length === 0) {
    // Fallback: maybe there's no descriptor, treat as single URL
    const trimmed = srcset.trim();
    if (trimmed) {
      const absoluteUrl = resolveUrl(trimmed, base);
      return absoluteUrl || trimmed;
    }
    return srcset;
  }

  return entries.join(', ');
}
