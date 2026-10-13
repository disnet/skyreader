// The reader's light/dark choice. 'system' (the default) follows the OS; the
// other two pin a scheme against it. Per https://lea.verou.me/blog/2026/dark-mode-toggles-2/
// the override is a rare intent, so it lives in Settings rather than as a
// control in the chrome.
//
// The choice is expressed as `<html data-theme="light|dark">` (absent for
// 'system'). Stylesheets keep writing `@media (prefers-color-scheme: dark)`;
// postcss.color-scheme.js compiles those into rules that honor the attribute.
//
// app.html carries an inline copy of `applyColorScheme` so the attribute is in
// place before first paint — keep the two in step (attribute name, storage key,
// and the theme-color handling).

export type ColorScheme = 'system' | 'light' | 'dark';

export const COLOR_SCHEME_OPTIONS: { value: ColorScheme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function coerceColorScheme(value: unknown): ColorScheme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function applyColorScheme(scheme: ColorScheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (scheme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', scheme);

  // app.html's theme-color tags pick by `prefers-color-scheme`. A pinned
  // scheme repoints their media so the browser chrome matches the page: the
  // pinned scheme's tag always matches, the other never does. Contents are
  // left alone — AppShell retints those for the framed layout.
  for (const tag of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][media]')) {
    const authored = (tag.dataset.media ??= tag.media);
    const tagScheme = /dark/.test(authored) ? 'dark' : 'light';
    tag.media = scheme === 'system' ? authored : scheme === tagScheme ? 'all' : 'not all';
  }
}
