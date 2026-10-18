import type { SavedSnapshot } from '$lib/services/api';
import { escapeHtml } from '$lib/utils/html';

/**
 * The Wayback Machine's copy of `url` nearest to `at` (a save's time), or its
 * latest when there's no time. The archive redirects a timestamp to the closest
 * capture it holds, so this works whether or not it has one from that day.
 */
export function waybackUrl(url: string, at?: string | number | null): string {
  const date = at == null ? null : new Date(at);
  const stamp =
    date && !Number.isNaN(date.getTime())
      ? date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
      : '';
  return `https://web.archive.org/web/${stamp}/${url}`;
}

/**
 * A failed-capture note with a way to the page as the Wayback Machine kept it.
 * Applied when the note is shown, not when it's stored, so notes saved before
 * this existed get it too.
 */
export function withWaybackLink(html: string, url: string, at?: string | number | null): string {
  const href = escapeHtml(waybackUrl(url, at));
  return `${html}\n<p><a href="${href}">Look for a copy on the Wayback Machine</a></p>`;
}

const METHOD_PHRASES: Record<NonNullable<SavedSnapshot['method']>, string> = {
  'live-dom': 'from the page in your browser',
  server: 'fetched by Skyreader',
  feed: 'from the feed',
  record: 'from the Atmosphere',
  upload: 'from your upload',
};

/** "Captured on 18 October 2026 at 09:12, from the feed." */
export function captureLine(snapshot: SavedSnapshot): string {
  const when = new Date(snapshot.capturedAt).toLocaleString(undefined, {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  const how = snapshot.method ? METHOD_PHRASES[snapshot.method] : null;
  return `Captured on ${when}${how ? `, ${how}` : ''}.`;
}

/**
 * A picture's address as a save's snapshot kept it: its `src`, or the first
 * `srcset` candidate when that isn't a web address (backend snapshotImageUrls).
 */
function keptImageAddress(img: HTMLImageElement): string | null {
  const web = (value: string | undefined) => (value && /^https?:\/\//i.test(value) ? value : null);
  return (
    web(img.getAttribute('src')?.trim()) ??
    // A candidate's address runs to its first space: it may hold commas itself.
    web(img.getAttribute('srcset')?.trim().split(/\s+/)[0]?.replace(/,$/, ''))
  );
}

/**
 * Point a saved article's picture that failed to load at the copy its snapshot
 * kept (`keptUrl`, the owner-only GET /api/saved/<rkey>/snapshot-image), so a
 * save keeps its pictures after the site loses them. Once per picture: if no
 * copy was kept, that request fails too and the picture stays as it was.
 * Returns whether it switched.
 */
export function fallBackToKeptImage(
  img: HTMLImageElement,
  keptUrl: (address: string) => string
): boolean {
  if (img.dataset.snapshotFallback) return false;
  const address = keptImageAddress(img);
  if (!address) return false;
  img.dataset.snapshotFallback = '1';
  // A srcset, or a <picture>'s sources, would win over the new src.
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  if (img.parentElement?.tagName === 'PICTURE') {
    for (const source of img.parentElement.querySelectorAll('source')) source.remove();
  }
  img.setAttribute('src', keptUrl(address));
  return true;
}
