// Links to an article's public link page ("Discussion across the Atmosphere"),
// served by linkblog-site at read.skyreader.app/<article URL>. Anyone can open
// one signed out, which is the point: it's the shareable version of the
// reader's Discussion panel.

import { browser } from '$app/environment';

// Link-page origin for a given app hostname. Prod, and staging-prod (a staging
// build against the production API), map to read.skyreader.app, so the page
// shows the same discussion the reader did; every other *.skyreader.app host to
// the staging read host; local dev to linkblog-site's dev server, which serves
// the same page under /link/ (port 5175, bound to 127.0.0.1).
export function linkPageBaseFor(hostname: string): string {
  if (hostname === 'skyreader.app' || hostname === 'staging-prod.skyreader.app') {
    return 'https://read.skyreader.app';
  }
  if (hostname.endsWith('.skyreader.app')) return 'https://staging-read.skyreader.app';
  if (hostname === '127.0.0.1' || hostname === 'localhost') return 'http://127.0.0.1:5175/link';
  return 'https://read.skyreader.app';
}

/**
 * The link page for an article, or null when the item has no public web
 * address (an emailed newsletter, an uploaded PDF, a relative path). The
 * article URL is appended as-is, minus its fragment: it stays readable, and its
 * query string is the article's own (the link page hands it back).
 */
export function linkPageUrl(
  articleUrl: string | null | undefined,
  hostname?: string
): string | null {
  // The longest article URL the link page (and its API) accepts.
  if (!articleUrl || articleUrl.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(articleUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.')) return null;
  url.hash = '';
  const host = hostname ?? (browser ? window.location.hostname : 'skyreader.app');
  return `${linkPageBaseFor(host)}/${url.href}`;
}
