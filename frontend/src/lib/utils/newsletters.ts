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
export const EMAIL_BODY_CLASS = 'sr-email-body';

/**
 * Second class on a saved newsletter whose full body couldn't be recovered at
 * save time (archive unreachable, or saved offline), so it holds only the
 * archive's lead or the summary. getContent (stores/saves.svelte.ts) sees it and
 * swaps in the full mail once the archive answers.
 */
export const EMAIL_LEAD_CLASS = 'sr-email-lead';

const EMAIL_BODY_OPEN = `<div class="${EMAIL_BODY_CLASS}">`;
const EMAIL_LEAD_OPEN = `<div class="${EMAIL_BODY_CLASS} ${EMAIL_LEAD_CLASS}">`;

// An opening wrapper however it was serialized: leading whitespace or a BOM,
// either quote style (or none), other attributes or classes beside it (a DOM
// round-trip through the sanitizer, or the backend's ingest wrap). The class
// has to be a whole token: `sr-email-body-wrapper` is a template's own class.
function wrapperStart(cls: string): RegExp {
  return new RegExp(
    `^[\\s\\uFEFF]*<div\\b[^>]*\\sclass\\s*=\\s*(?:(["'])(?:[^"']*\\s)?${cls}(?:\\s[^"']*)?\\1|${cls}(?=[\\s>]))[^>]*>`,
    'i'
  );
}

const EMAIL_BODY_START = wrapperStart(EMAIL_BODY_CLASS);
const EMAIL_LEAD_START = wrapperStart(EMAIL_LEAD_CLASS);

/** Whether `html` is already wrapped in the email-body scope. */
export function isEmailBody(html: string | null | undefined): boolean {
  return !!html && EMAIL_BODY_START.test(html);
}

/** Whether `html` is a newsletter save holding only its lead (see EMAIL_LEAD_CLASS). */
export function isEmailLead(html: string | null | undefined): boolean {
  return !!html && EMAIL_BODY_START.test(html) && EMAIL_LEAD_START.test(html);
}

/** Wrap a newsletter body in the email-body scope; idempotent. */
export function wrapEmailBody(html: string): string;
export function wrapEmailBody(html: string | null): string | null;
export function wrapEmailBody(html: string | null | undefined): string | null | undefined;
export function wrapEmailBody(html: string | null | undefined): string | null | undefined {
  if (!html || isEmailBody(html)) return html;
  return `${EMAIL_BODY_OPEN}${html}</div>`;
}

/**
 * Wrap a newsletter's lead (or summary) standing in for a body that couldn't be
 * recovered. Always adds its own wrapper: a lead cut from an already-wrapped
 * body starts with the plain scope, which would hide the marker.
 */
export function wrapEmailLead(html: string): string {
  if (isEmailLead(html)) return html;
  return `${EMAIL_LEAD_OPEN}${html}</div>`;
}
