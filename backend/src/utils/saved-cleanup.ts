/**
 * Tidying a save's metadata as it's written, whichever way it arrives: a
 * read-later import (routes/saved-import.ts), a save from the reader
 * (routes/saved.ts), or a background extraction (services/saved-content.ts).
 *
 * Each source gets something wrong in its own way. Exports keep the newsletter
 * tracking on a link, and Readwise names a page it couldn't title "Unnamed
 * Document". Feeds put anything in a summary, up to the whole post as HTML. An
 * extractor takes the domain from the page's canonical link, which for a paper
 * can be dx.doi.org. These fix what they can without fetching anything.
 */

import { publicExcerpt } from './html-text';

/**
 * Query parameters that only ever say how a reader arrived: removed from an
 * imported link, so the save is the article's own address. Narrower than
 * url-normalize.ts's TRACKING_PARAMS, which also drops names like `ref` and
 * `source` for matching: a stored link has to keep working, and some sites use
 * those to pick the page. A gift link's token (`view_token`,
 * `unlocked_article_code`) stays, since it's what lets the reader in.
 */
const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|mc_cid|mc_eid|_bhlid|fbclid|gclid|dclid|msclkid|igshid|_hsenc|_hsmi|mkt_tok|vero_id|oly_anon_id|oly_enc_id|ck_subscriber_id)$/i;

/**
 * `url` without its tracking parameters. The rest of the query is kept byte for
 * byte, in its order: re-serializing it would re-encode what the site wrote.
 */
export function withoutTrackingParams(url: URL): URL {
  if (url.search.length <= 1) return url;
  const pairs = url.search.slice(1).split('&');
  const kept = pairs.filter((pair) => {
    // An empty pair (`?&a=1`) goes; one joined to another by `;` is left whole.
    if (!pair) return false;
    if (pair.includes(';')) return true;
    const name = pair.split('=', 1)[0];
    let decoded = name;
    try {
      decoded = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      // Malformed escapes: match on the name as written.
    }
    return !TRACKING_PARAM.test(decoded);
  });
  if (kept.length === pairs.filter(Boolean).length) return url;
  const clean = new URL(url.href);
  // A query emptied of everything leaves no bare "?".
  clean.search = kept.length ? `?${kept.join('&')}` : '';
  return clean;
}

/**
 * A newsletter's click-tracking link: the address the reader clicked in an
 * email, which redirects to the article. beehiiv and SendGrid write them as
 * /ss/c/<token> on the sender's own tracking host (link.mail.beehiiv.com,
 * elink123.www.garbageday.email), Substack as substack.com/redirect/…, and
 * Mailchimp as …list-manage.com/track/click.
 */
export function isClickTrackingUrl(value: string | URL | null | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = typeof value === 'string' ? new URL(value) : value;
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (path.startsWith('/ss/c/')) return true;
  if ((host === 'substack.com' || host.endsWith('.substack.com')) && path.startsWith('/redirect/'))
    return true;
  return host.endsWith('.list-manage.com') && path.startsWith('/track/click');
}

/** The domain a save is labelled with: its own URL's host, without `www.`. */
export function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

// Hosts an extractor reports when it took a paper's domain from its DOI link.
const DOI_HOSTS = new Set(['doi.org', 'dx.doi.org']);

/**
 * The domain to label a save with: the one its extraction reported, unless
 * that's missing or a DOI resolver (dx.doi.org for a journal article), when
 * it's the save's own host. A click-tracking link's host is no better than
 * nothing, so it never stands in.
 */
export function saveDomain(url: string | null | undefined, reported: unknown): string | null {
  const claimed = typeof reported === 'string' && reported.trim() ? reported.trim() : null;
  if (claimed && !DOI_HOSTS.has(claimed.toLowerCase().replace(/^www\./, ''))) return claimed;
  if (url && !isClickTrackingUrl(url)) return domainOf(url) ?? claimed;
  return claimed;
}

// Titles an app gives a page it couldn't name. Better none, so the next
// extraction fills in the page's own.
const PLACEHOLDER_TITLES = new Set(['unnamed document', 'untitled', 'untitled document']);

/** `title`, or null when it's a placeholder rather than the page's name. */
export function realTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim();
  if (!trimmed) return null;
  return PLACEHOLDER_TITLES.has(trimmed.toLowerCase()) ? null : trimmed;
}

/**
 * How long a save's description may run: a few lines on a card. The article
 * itself is the body; a description is only what sums it up.
 */
export const SAVE_DESCRIPTION_CHARS = 500;

/**
 * A save's description, as plain text short enough for a card. Only when the
 * save has a body of its own: one without shows its description in the
 * reader in place of the article (frontend displayItem.ts), so it's kept as it
 * came. Null when nothing is left.
 */
export function saveDescription(
  description: string | null | undefined,
  hasBody: boolean
): string | null {
  if (!description) return null;
  if (!hasBody) return description;
  return publicExcerpt(description, SAVE_DESCRIPTION_CHARS) || null;
}
