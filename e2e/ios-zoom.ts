import { expect, type Page } from '@playwright/test';

// iOS Safari zooms the whole page into a text field that takes focus with a
// font-size under 16px, and never zooms back out. The fix is one CSS line per
// field, which is exactly why it keeps getting missed: nothing on a desktop
// screen shows it, and a size built from `calc(var(--article-font-size) * …)`
// can clear 16px at the default and dip under it once the reader changes a
// preference. So measure what the browser actually computes, not the source.
export const IOS_MIN_FIELD_PX = 16;

/**
 * A phone, as far as CSS can tell: phone-width viewport and a touch screen, so
 * `@media (pointer: coarse)` rules (where most of the 16px floors live) apply.
 * Chromium, not WebKit — the check is computed style, which doesn't need
 * Safari, and the main suite only installs Chromium.
 */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const FIELD_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

// Input types iOS never zooms into: nothing to type.
const NON_TEXT_INPUTS = [
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
];

/** Every visible, enabled text field on the page that would zoom on focus, described. */
export async function zoomingFields(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ selector, nonText, min }) => {
      const describe = (el: HTMLElement) => {
        const tag = el.tagName.toLowerCase();
        const label =
          el.getAttribute('aria-label') ??
          el.getAttribute('placeholder') ??
          el.getAttribute('name') ??
          (el.id ? `#${el.id}` : null);
        const cls = [...el.classList].filter((c) => !c.startsWith('svelte-')).join('.');
        return `<${tag}${cls ? `.${cls}` : ''}>${label ? ` "${label}"` : ''}`;
      };

      const offenders: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (el instanceof HTMLInputElement && nonText.includes(el.type)) continue;
        if ((el as HTMLInputElement).disabled) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const px = parseFloat(style.fontSize);
        if (px < min) offenders.push(`${describe(el)} is ${px}px`);
      }
      return offenders;
    },
    { selector: FIELD_SELECTOR, nonText: NON_TEXT_INPUTS, min: IOS_MIN_FIELD_PX }
  );
}

/**
 * Fail if any text field on screen is under 16px. Checks the page is emulating
 * a touch screen first: without it the `pointer: coarse` floors don't apply and
 * a failure would be about the test setup, not the field.
 */
export async function expectNoZoomingFields(page: Page, where = 'this page') {
  expect(
    await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
    'expected a touch-screen page (use `test.use(PHONE)`)'
  ).toBe(true);
  expect(
    await zoomingFields(page),
    `text fields on ${where} under ${IOS_MIN_FIELD_PX}px make iOS Safari zoom on focus`
  ).toEqual([]);
}
