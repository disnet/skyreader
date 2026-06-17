// Shared theming for the magazine (curated edition) view. The publication's
// basicTheme colors + publicationTheme fonts are turned into a single string of
// CSS custom properties, applied both to the magazine component and (so the
// color breaks out of the content column) to the whole reader overlay.
import type { BasicTheme, ReaderCollection } from '$lib/types';

// Only simple Google-Font family names are honored; anything else is ignored so a
// hostile record can't inject into the <link> href or a font-family value.
const FONT_NAME_RE = /^[A-Za-z0-9 ]+$/;

export function safeFontName(name: string | undefined): string | undefined {
  const n = name?.trim();
  return n && FONT_NAME_RE.test(n) ? n : undefined;
}

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = 'system-ui, -apple-system, sans-serif';

function rgb(c: { r: number; g: number; b: number } | undefined, fallback: string): string {
  return c ? `rgb(${c.r} ${c.g} ${c.b})` : fallback;
}

// A CSS font-family stack: the publication font (quoted) ahead of a fallback, or
// just the fallback when no valid font is set.
function fontStack(name: string | undefined, fallback: string): string {
  return name ? `"${name}", ${fallback}` : fallback;
}

/**
 * Build the `--mag-*` custom properties for an edition. Colors apply as-is when a
 * theme is present (an intentional, publication-owned palette); the fallbacks keep
 * the surface readable when it isn't. Body font drives prose + labels; the title
 * font + upright style style the masthead headline (display faces like "Black Ops
 * One" have no italic, so we don't fake one).
 */
export function magazineThemeVars(collection: ReaderCollection): string {
  const theme: BasicTheme = collection.theme ?? {};
  const titleFont = safeFontName(collection.fonts?.title);
  const bodyFont = safeFontName(collection.fonts?.body);
  return [
    `--mag-bg:${rgb(theme.background, 'var(--color-bg, #fff)')}`,
    `--mag-fg:${rgb(theme.foreground, 'var(--color-text, #1a1a1a)')}`,
    `--mag-accent:${rgb(theme.accent, 'var(--color-primary, #0066cc)')}`,
    `--mag-accent-fg:${rgb(theme.accentForeground, '#fff')}`,
    `--mag-title-font:${fontStack(titleFont, SERIF)}`,
    `--mag-title-style:${titleFont ? 'normal' : 'italic'}`,
    `--mag-body-font:${fontStack(bodyFont, SERIF)}`,
    `--mag-label-font:${fontStack(bodyFont, SANS)}`,
  ].join(';');
}

/** The Google Fonts stylesheet URL for the edition's fonts, or null if none. */
export function magazineFontHref(collection: ReaderCollection): string | null {
  const families = [
    ...new Set(
      [safeFontName(collection.fonts?.title), safeFontName(collection.fonts?.body)].filter(
        (f): f is string => !!f
      )
    ),
  ];
  if (families.length === 0) return null;
  const params = families.map((f) => `family=${f.replace(/ /g, '+')}`).join('&');
  return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}
