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
 * Sanitizes HTML content, rewrites relative URLs to be absolute
 * based on the article's source URL, and opens all links in new tab.
 */
export function sanitizeHtml(html: string, baseUrl?: string): string {
  if (!html) return '';

  let base: URL | null = null;
  if (baseUrl) {
    try {
      base = new URL(baseUrl);
    } catch {
      // Invalid base URL, continue without URL rewriting
    }
  }

  // Add hook to process URLs and links
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // Rewrite img src (only if we have a valid base)
    if (base && node.tagName === 'IMG' && node.hasAttribute('src')) {
      const src = node.getAttribute('src');
      if (src) {
        const absoluteUrl = resolveUrl(src, base);
        if (absoluteUrl) {
          node.setAttribute('src', absoluteUrl);
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
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'referrerpolicy', 'scrolling'],
  });

  // Remove hook to avoid affecting other calls
  DOMPurify.removeHook('afterSanitizeAttributes');

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
