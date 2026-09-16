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
  window.location.assign(saveAnywhereUrl(window.navigator.userAgent));
}
