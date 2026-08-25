// Semble's URL keying, on the reader's side.
//
// Semble identifies a card by the *exact* URL string, so `/post` and `/post/`
// are two different cards (see feed-proxy/src/semble-client.ts, which picks
// between the variants by which one actually holds anything). That matters when
// writing a connection: an edge naming the wrong variant is real, but it rolls
// up onto a card page the reader was never looking at.

/** This URL's card page on semble.so — the same construction the proxy uses. */
export function sembleCardUrl(url: string | null | undefined): string | null {
  return url ? `https://semble.so/url/${encodeURIComponent(url)}` : null;
}

/**
 * Recover the URL string Semble actually holds for an article, out of the card
 * page the panel resolved (`https://semble.so/url/<encoded>`). That encoded
 * segment *is* the variant Semble keyed the card under, so it beats our own copy
 * of the article URL. Falls back to `fallback` when there's no card page yet, or
 * it isn't the shape we expect.
 */
export function sembleSourceUrl(cardUrl: string | null | undefined, fallback: string): string {
  if (!cardUrl) return fallback;
  try {
    const parsed = new URL(cardUrl);
    if (parsed.hostname !== 'semble.so') return fallback;
    const match = parsed.pathname.match(/^\/url\/(.+)$/);
    if (!match) return fallback;
    const decoded = decodeURIComponent(match[1]);
    const asUrl = new URL(decoded);
    if (asUrl.protocol !== 'http:' && asUrl.protocol !== 'https:') return fallback;
    return decoded;
  } catch {
    return fallback;
  }
}
