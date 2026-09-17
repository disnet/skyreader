export const CHROME_EXTENSION_URL =
  'https://chromewebstore.google.com/detail/skyreader/kdefpnnpmajcclfepekgdkcdiklfooed';
export const FIREFOX_EXTENSION_URL = 'https://addons.mozilla.org/firefox/addon/skyreader/';
export const SAVE_ANYWHERE_SETTINGS_URL = '/settings#save-anywhere';
export const SAVE_ANYWHERE_LABEL = 'Save from anywhere';

/**
 * Send supported desktop browsers straight to their extension. Mobile browsers
 * use the settings instructions instead: Chrome and Firefox both identify
 * themselves in their iOS/Android user agents, but cannot use these desktop
 * extension listings there.
 */
export function saveAnywhereUrl(userAgent: string): string {
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  if (isMobile) return SAVE_ANYWHERE_SETTINGS_URL;

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
 * actually points: on mobile, and on desktop browsers with no listing of ours,
 * there is no extension to install, so promising one there would send the reader
 * looking for something that isn't here.
 */
export function saveAnywhereHint(userAgent: string): string {
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
