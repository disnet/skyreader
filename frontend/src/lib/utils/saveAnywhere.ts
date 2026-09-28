import { docsUrl } from '$lib/constants/docs';
import { escapeHtml } from '$lib/utils/html';

export const CHROME_EXTENSION_URL =
  'https://chromewebstore.google.com/detail/skyreader/kdefpnnpmajcclfepekgdkcdiklfooed';
export const FIREFOX_EXTENSION_URL = 'https://addons.mozilla.org/firefox/addon/skyreader/';
export const SAVE_ANYWHERE_SETTINGS_URL = '/settings#save-anywhere';
export const SAVE_ANYWHERE_LABEL = 'Save from anywhere';

function isMobile(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

/**
 * Send supported desktop browsers straight to their extension. Mobile browsers
 * use the settings instructions instead: Chrome and Firefox both identify
 * themselves in their iOS/Android user agents, but cannot use these desktop
 * extension listings there.
 */
export function saveAnywhereUrl(userAgent: string): string {
  if (isMobile(userAgent)) return SAVE_ANYWHERE_SETTINGS_URL;

  if (/Firefox\//i.test(userAgent)) return FIREFOX_EXTENSION_URL;
  if (/Chrome\//i.test(userAgent) && !/Edg\/|OPR\//i.test(userAgent)) {
    return CHROME_EXTENSION_URL;
  }

  return SAVE_ANYWHERE_SETTINGS_URL;
}

export function saveAnywhereLabel(userAgent: string): string {
  const url = saveAnywhereUrl(userAgent);
  if (url === CHROME_EXTENSION_URL) return 'Install Chrome extension';
  if (url === FIREFOX_EXTENSION_URL) return 'Install Firefox extension';
  return SAVE_ANYWHERE_LABEL;
}

export function openSaveAnywhere(): void {
  const url = saveAnywhereUrl(window.navigator.userAgent);
  // Extension listings leave the app, so keep the reader open behind them.
  if (url === SAVE_ANYWHERE_SETTINGS_URL) {
    window.location.assign(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * What a reader is told when the site refused the server's fetcher. Deliberately
 * not an apology and not a technical account of bot filters: the page is open in
 * their browser, so there is a way through, and the line's whole job is to point
 * at it.
 */
export const BLOCKED_SAVE_LINE = 'That site blocks automated readers.';

/**
 * The sentence that follows BLOCKED_SAVE_LINE. It has to match where the action
 * actually points. On a phone there is no extension to install here, but the
 * extensions are still the way to the full text, so the hint names them and
 * where they run (the settings the action opens link both). Desktop browsers with
 * no listing of ours get no extension promise.
 */
export function saveAnywhereHint(userAgent: string): string {
  if (isMobile(userAgent)) {
    return 'On a computer, the Chrome or Firefox extension can save it from the page itself.';
  }
  if (saveAnywhereUrl(userAgent) === SAVE_ANYWHERE_SETTINGS_URL) {
    return "Saving it from the page you're on still works.";
  }
  return 'The extension saves it from the page you already have open.';
}

/** Where a blocked save sends the reader, and what they are told about it. */
export interface BlockedSaveAction {
  label: string;
  href: string;
  hint: string;
}

/** The way through, labelled for whatever browser the reader is in. */
export function blockedSaveAction(): BlockedSaveAction {
  const ua = window.navigator.userAgent;
  return { label: saveAnywhereLabel(ua), href: saveAnywhereUrl(ua), hint: saveAnywhereHint(ua) };
}

/**
 * Why a URL save came back without the article. `blocked` is the site refusing
 * the server's fetcher; `failed` is anything else that went wrong fetching or
 * extracting the page (a timeout, a broken page, the proxy itself).
 */
export type SaveFetchFailure = 'blocked' | 'failed';

/**
 * Marks a body as the note from failedSaveBody rather than article text, so it
 * is never counted as words (a read time for a page nobody fetched) and a later
 * save that does fetch the article knows it may replace it.
 */
const FAILED_SAVE_MARKER = 'data-skyreader-note="fetch-failed"';

/** Whether `html` is the note a link-only save stores in place of the article. */
export function isFailedSaveBody(html: string | null | undefined): boolean {
  return Boolean(html?.includes(FAILED_SAVE_MARKER));
}

/**
 * The body of a save whose article couldn't be fetched. The link is still worth
 * keeping, so the save goes through with this note in place of the text: what
 * happened, a way to the page itself, and the way through (the extension reads
 * the page from the reader's own browser, and re-saving from it replaces this
 * note with the full text).
 */
export function failedSaveBody(url: string, reason: SaveFetchFailure): string {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // Keep the raw URL as the link text.
  }
  const why =
    reason === 'blocked'
      ? "Skyreader couldn't fetch this article: the site blocks automated readers."
      : "Skyreader couldn't fetch this article.";
  const link = (href: string, text: string) =>
    `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  return [
    `<p ${FAILED_SAVE_MARKER}>${why} The link is saved, so it's here when you want it.</p>`,
    `<p>${link(url, `Read it on ${host}`)}</p>`,
    '<p>The browser extension can still save the full text. Open the article, then use ' +
      '<strong>Save this page</strong>; it replaces this note.</p>',
    `<p>${link(CHROME_EXTENSION_URL, 'Chrome extension')} · ` +
      `${link(FIREFOX_EXTENSION_URL, 'Firefox extension')} · ` +
      `${link(docsUrl('siteBlocksSaving'), "When a site won't let Skyreader read it")}</p>`,
  ].join('\n');
}

/** The line a caller shows once a save kept only the link. */
export function failedSaveLine(reason: SaveFetchFailure): string {
  return reason === 'blocked'
    ? `Saved the link only. ${BLOCKED_SAVE_LINE}`
    : "Saved the link only. Skyreader couldn't fetch the article.";
}
