import { test, expect } from './fixtures';

/**
 * The framed shell (>1000px) is pinned to the viewport: the content card is the
 * scroller, so the document itself must have nothing to scroll. It regressed on
 * iPad Safari because `html, body { min-height: 100vh }` measures the *large*
 * viewport — the one you get with the address bar collapsed — so the document
 * was always taller than what was on screen and the whole frame slid up with
 * the bar. A headless browser has no address bar to reproduce that with, but the
 * invariant it violated is checkable here: in the framed layout the document
 * never overflows and never moves.
 */
test.describe('framed shell', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the document does not scroll', async ({ authedPage: page }) => {
    await page.goto('/feeds');
    await expect(page.locator('#app-scroll')).toBeVisible();

    const doc = await page.evaluate(() => ({
      // The lock itself. A headless browser has no address bar, so the height
      // comparisons below would pass with or without it — this is the assertion
      // that actually fails if the framed block goes away.
      overflowY: getComputedStyle(document.documentElement).overflowY,
      overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
    }));
    expect(doc.overflowY).toBe('hidden');
    expect(doc.overscroll).toBe('none');
    expect(doc.scrollHeight).toBeLessThanOrEqual(doc.clientHeight);
    expect(doc.bodyScrollHeight).toBeLessThanOrEqual(doc.clientHeight);

    // And it stays put when something tries to move it.
    await page.evaluate(() => window.scrollTo(0, 500));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('the ground runs full bleed', async ({ authedPage: page }) => {
    await page.goto('/feeds');
    await expect(page.locator('#app-scroll')).toBeVisible();

    // The canvas token is painted on the document, not just on the shell's own
    // box, so it fills the safe areas and whatever the browser paints around
    // the page. `theme-color` — what Safari tints its address bar with — is
    // retinted to the same value.
    const { body, canvas, themeColors } = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      canvas: getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim(),
      themeColors: [...document.querySelectorAll('meta[name="theme-color"]')].map(
        (tag) => (tag as HTMLMetaElement).content
      ),
    }));

    expect(canvas).toBeTruthy();
    // #f1f1f1 → rgb(241, 241, 241)
    expect(body).toBe('rgb(241, 241, 241)');
    expect(themeColors.length).toBeGreaterThan(0);
    for (const color of themeColors) expect(color).toBe(canvas);
  });
});

test.describe('outside the app shell', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  // app.css is shared with the pages that render without the shell. The lock
  // and the ground colour must not reach them: they are ordinary
  // window-scrolling documents on Surface, and a locked <html> would leave a
  // wide screen unable to reach the bottom of a long legal page.
  test('a logged-out page still scrolls, on Surface', async ({ page }) => {
    await page.goto('/terms');

    const doc = await page.evaluate(() => ({
      hasShell: document.documentElement.classList.contains('has-app-shell'),
      overflowY: getComputedStyle(document.documentElement).overflowY,
      // Surface is painted on :root (app.css), with body left transparent.
      background: getComputedStyle(document.documentElement).backgroundColor,
    }));
    expect(doc.hasShell).toBe(false);
    expect(doc.overflowY).not.toBe('hidden');
    expect(doc.background).toBe('rgb(255, 255, 255)');
  });
});

test.describe('mobile shell', () => {
  test.use({ viewport: { width: 393, height: 727 } });

  test('the window is still the scroller', async ({ authedPage: page }) => {
    await page.goto('/feeds');

    // No inner scroll container below the breakpoint — the mobile URL-bar
    // collapse and pull-to-refresh both need the window to be what scrolls.
    const overflowY = await page.evaluate(
      () => getComputedStyle(document.documentElement).overflowY
    );
    expect(overflowY).not.toBe('hidden');
  });
});
