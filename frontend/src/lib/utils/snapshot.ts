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
