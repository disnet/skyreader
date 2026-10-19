// Words for a Semble connection the Shelf describes (library/NewConnections).
// The server keeps only the other end's URL, so the label is read off it: the
// site, then the page's slug when it reads as words.

import { domainFromUrl } from './highlightSource';

/** "elsewhere.net · why reading adds up", or just the site. */
export function connectionTargetLabel(url: string): string {
  const site = domainFromUrl(url);
  if (!site) return url;
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  let slug = segments.at(-1) ?? '';
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Keep it as written.
  }
  slug = slug.replace(/\.(html?|php|aspx?)$/i, '');
  const words = slug.split(/[-_+]+/).filter(Boolean);
  // An id or a hash isn't a title: want a few words, mostly letters.
  const wordy =
    words.length >= 2 &&
    words.filter((w) => /^[\p{L}]+$/u.test(w)).length >= Math.ceil(words.length / 2);
  return wordy ? `${site} · ${words.join(' ')}` : site;
}

/** Semble's connection type ("SUPPORTS", "LEADS_TO") as a lowercase phrase, or null. */
export function connectionTypeLabel(type: string | null): string | null {
  if (!type) return null;
  const words = type.toLowerCase().replace(/_/g, ' ').trim();
  return words || null;
}
