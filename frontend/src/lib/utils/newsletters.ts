import type { Subscription } from '$lib/types';

/**
 * Email newsletters (a Supporter feature). Mail sent to the reader's private
 * address lands server-side as one subscription per sender, with `feedUrl`
 * `newsletter:<inbox id>/<sender>` — not fetchable, never on the PDS, and
 * readable only by its owner. Its items sit in the same D1 archive as RSS, so
 * everything that reads that archive (timeline, unread counts, "Show older",
 * mark-all-read, channels) treats it like a feed; only fetching it from the
 * crawler makes no sense.
 */
export const NEWSLETTER_SOURCE_TYPE = 'email.newsletter';

export function isNewsletterSource(sourceType: string | undefined): boolean {
  return sourceType === NEWSLETTER_SOURCE_TYPE;
}

export function isNewsletterSubscription(
  sub: Pick<Subscription, 'sourceType' | 'feedUrl'>
): boolean {
  return isNewsletterSource(sub.sourceType) || !!sub.feedUrl?.startsWith('newsletter:');
}

/** Sources whose items live in the D1 feed archive: RSS (the default) and newsletters. */
export function isArchiveFeedSource(sourceType: string | undefined): boolean {
  return !sourceType || sourceType === 'rss' || sourceType === NEWSLETTER_SOURCE_TYPE;
}

/** The sender address a newsletter subscription collects mail from. */
export function newsletterSender(feedUrl: string | undefined): string | null {
  if (!feedUrl?.startsWith('newsletter:')) return null;
  const slash = feedUrl.indexOf('/');
  return slash > 0 ? feedUrl.slice(slash + 1) || null : null;
}

/**
 * Class on the wrapper that marks a body as emailed newsletter HTML. Email
 * templates size their type through markup the sanitizer can't tell from
 * article structure (<h1> as a 12px footer, <small> for whole sections,
 * layout tables several deep), so stripping attributes alone keeps leaking
 * odd sizes into the reader. The wrapper lets app.css reset every element in
 * the body to the reader's own size instead of enumerating the tricks; a
 * heading tag still steps up a little (it can't be told from a real one).
 *
 * The backend wraps newsletter bodies at ingest (newsletter-email.ts); this
 * covers rows archived before it did, and saves made from them.
 */
export const EMAIL_BODY_CLASS = 'email-body';

const EMAIL_BODY_OPEN = `<div class="${EMAIL_BODY_CLASS}">`;

// An opening wrapper however it was serialized: leading whitespace or a BOM,
// either quote style, other attributes or classes beside it (a DOM round-trip
// through the sanitizer, or the backend's ingest wrap).
const EMAIL_BODY_START = new RegExp(
  `^[\\s\\uFEFF]*<div\\b[^>]*\\bclass\\s*=\\s*["']?[^"'>]*\\b${EMAIL_BODY_CLASS}\\b[^>]*>`,
  'i'
);

/** Whether `html` is already wrapped in the email-body scope. */
export function isEmailBody(html: string | null | undefined): boolean {
  return !!html && EMAIL_BODY_START.test(html);
}

/** Wrap a newsletter body in the email-body scope; idempotent. */
export function wrapEmailBody(html: string): string;
export function wrapEmailBody(html: string | null): string | null;
export function wrapEmailBody(html: string | null | undefined): string | null | undefined;
export function wrapEmailBody(html: string | null | undefined): string | null | undefined {
  if (!html || isEmailBody(html)) return html;
  return `${EMAIL_BODY_OPEN}${html}</div>`;
}
