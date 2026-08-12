import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { seedSavedArticle, type TestUser } from './seed';

// Fullscreen paged reading is a touch surface: the bug these tests pin down only
// exists on the real touch event path, where the browser replays a finished tap as
// a mouse click. Chromium emulates that replay, so the context needs touch and a
// phone-sized viewport (one column, many pages). Reduced motion turns pages
// instantly (see PagedView's prefers-reduced-motion rule), which keeps the
// coordinate math free of a mid-transition layout race.
//
// Note on engines: Chromium aims the replayed click at the node the finger first
// touched, so here it re-clicks the page being left; WebKit/iOS re-hit-tests at the
// release point, which is how the report's "it opened a link on the next page"
// happens. Both are the same defect — a page-turn tap that also produces a click —
// so these tests assert the replay doesn't reach the article at all.
test.use({ hasTouch: true, viewport: { width: 430, height: 860 }, reducedMotion: 'reduce' });

const ARTICLE_TITLE = 'A Long Paged Article';
const ARTICLE_URL = 'https://example.com/paged/long-article';

/**
 * Enough prose to guarantee many pages, with a wide link in every paragraph so a
 * stray click after a page turn lands on something the reader visibly reacts to —
 * exactly the "tapped to turn the page, opened a link instead" report.
 */
function pagedBody(): string {
  const paragraphs = Array.from({ length: 60 }, (_, i) => {
    const href = `https://example.com/trap/${i}`;
    // Paragraph lengths cycle rather than repeat, so links don't land on the same
    // line of every page — the tests need a coordinate that is plain text on one
    // page and a link on the next.
    const filler = Array.from(
      { length: (i % 5) + 1 },
      (_, j) =>
        `Sentence ${j + 1} of paragraph ${i} keeps the column flowing past the fold, ` +
        `so the article needs many pages to read on a phone-sized screen.`
    ).join(' ');
    return `<p><a href="${href}">Trap link ${i} runs the full width of the column</a> ${filler}</p>`;
  });
  return paragraphs.join('');
}

interface RecordedClick {
  tag: string;
  href: string | null;
}

declare global {
  interface Window {
    __pagedClicks?: RecordedClick[];
  }
}

/**
 * Record clicks that reach the paged column. The recorder sits on `.paged-content`
 * in the capture phase, i.e. *below* PagedView's document-level suppressor and
 * *above* the reader's own link interception — so it sees every click the article
 * would act on, and none that the fix swallows on the way down.
 */
async function recordContentClicks(page: Page) {
  await page.evaluate(() => {
    const content = document.querySelector('.paged-content');
    if (!content) throw new Error('no .paged-content to record clicks on');
    window.__pagedClicks = [];
    content.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement;
        window.__pagedClicks!.push({
          tag: target.tagName,
          href: target.closest('a')?.getAttribute('href') ?? null,
        });
      },
      true
    );
  });
}

async function takeClicks(page: Page): Promise<RecordedClick[]> {
  return page.evaluate(() => {
    const clicks = window.__pagedClicks ?? [];
    window.__pagedClicks = [];
    return clicks;
  });
}

/** Seed one long article, open its reader, and switch to paged mode. */
async function openPagedReader(page: Page, user: TestUser) {
  await seedSavedArticle(user, {
    url: ARTICLE_URL,
    title: ARTICLE_TITLE,
    domain: 'example.com',
    contentType: 'article',
    content: pagedBody(),
    wordCount: 1200,
  });

  await page.goto('/?saved=true');
  await page.getByText(ARTICLE_TITLE).first().click({ timeout: 15_000 });

  // Both the mobile bottom bar and the desktop toolbar carry the toggle; only one
  // of them is on screen at this viewport.
  await page.getByTitle('Switch to paged view').locator('visible=true').click({ timeout: 15_000 });

  const count = page.locator('.paged-count');
  await expect(count).toBeVisible({ timeout: 15_000 });
  // Wait for a stable multi-page layout before deriving any coordinates from it.
  await expect(count).toHaveText(/^Page 1 of (?!1$)\d+$/, { timeout: 15_000 });
  await settlePageTransform(page);
  await recordContentClicks(page);
}

async function pageLabel(page: Page): Promise<string> {
  return (await page.locator('.paged-count').textContent())?.trim() ?? '';
}

/**
 * A page turn slides the column with a CSS transition. Coordinates read mid-slide
 * describe a layout that no longer exists by the time we tap, so wait for the
 * transform to hold still first.
 */
async function settlePageTransform(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const content = document.querySelector<HTMLElement>('.paged-content');
        if (!content) return resolve();
        let previous = getComputedStyle(content).transform;
        let stableFrames = 0;
        const tick = () => {
          const current = getComputedStyle(content).transform;
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 5) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })
  );
}

/**
 * A point in the viewport's next-page zone (right 30%) that is NOT over a link or
 * control on the *current* page — i.e. a tap the reader is supposed to consume as a
 * page turn. Derived from `.paged-viewport` so it holds at any layout.
 */
async function nextZonePoint(page: Page) {
  const point = await page.evaluate(() => {
    const viewport = document.querySelector('.paged-viewport');
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const x = rect.left + rect.width * 0.85;
    const interactive = 'a, button, input, textarea, select, video, audio, iframe, [role="button"]';
    for (let fraction = 0.2; fraction <= 0.8; fraction += 0.05) {
      const y = rect.top + rect.height * fraction;
      const el = document.elementFromPoint(x, y);
      if (!el || el.closest(interactive)) continue;
      return { x, y };
    }
    return null;
  });
  expect(point, 'found a non-interactive point in the next-page zone').not.toBeNull();
  return point!;
}

/** The widest link currently rendered on the visible page, and a point inside it. */
async function visibleLinkPoint(page: Page) {
  const found = await page.evaluate(() => {
    const viewport = document.querySelector('.paged-viewport');
    if (!viewport) return null;
    const bounds = viewport.getBoundingClientRect();
    let best: { x: number; y: number; href: string; text: string; width: number } | null = null;
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('.paged-content a[href]')) {
      for (const rect of anchor.getClientRects()) {
        // Off-page columns sit outside the viewport box (the content is translated
        // sideways), so this keeps us on the page the reader is showing.
        if (rect.left < bounds.left || rect.right > bounds.right) continue;
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) continue;
        if (rect.width < 40 || rect.height < 8) continue;
        if (best && rect.width <= best.width) continue;
        best = {
          x: rect.right - 6,
          y: rect.top + rect.height / 2,
          href: anchor.getAttribute('href') ?? '',
          text: anchor.textContent?.trim() ?? '',
          width: rect.width,
        };
      }
    }
    return best;
  });
  expect(found, 'found a link on the current page').not.toBeNull();
  return found!;
}

/**
 * A point in the next-page zone that a link will occupy *after* the turn — the
 * exact coordinate the report is about. Found by peeking at the next page with the
 * pager, then coming back and confirming the same point is harmless right now.
 * (Chromium won't re-hit-test its replayed click onto that link, but the fixture
 * still matches the report and the assertion covers engines that do.)
 */
async function trapPoint(page: Page) {
  const next = page.getByRole('button', { name: 'Next page' });
  const previous = page.getByRole('button', { name: 'Previous page' });
  const before = await pageLabel(page);

  await next.click();
  await expect(page.locator('.paged-count')).not.toHaveText(before);
  await settlePageTransform(page);
  const candidates = await page.evaluate(() => {
    const viewport = document.querySelector('.paged-viewport');
    if (!viewport) return [];
    const bounds = viewport.getBoundingClientRect();
    const points: { x: number; y: number; href: string }[] = [];
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('.paged-content a[href]')) {
      for (const rect of anchor.getClientRects()) {
        if (rect.left < bounds.left || rect.right > bounds.right) continue;
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) continue;
        const x = rect.right - 6;
        // Must sit in the next-page tap zone (right 30%) to be the coordinate the
        // page-turn tap releases on.
        if ((x - bounds.left) / bounds.width < 0.75) continue;
        points.push({ x, y: rect.top + rect.height / 2, href: anchor.getAttribute('href') ?? '' });
      }
    }
    return points;
  });
  expect(candidates.length, 'links sitting in the next page’s tap zone').toBeGreaterThan(0);

  await previous.click();
  await expect(page.locator('.paged-count')).toHaveText(before);
  await settlePageTransform(page);
  // Keep only the coordinates that are plain reading area on the page being left,
  // so the tap is unambiguously a page turn and any link it activates belongs to
  // the page it revealed.
  const point = await page.evaluate((points) => {
    const interactive = 'a, button, input, textarea, select, video, audio, iframe, [role="button"]';
    return points.find((p) => !document.elementFromPoint(p.x, p.y)?.closest(interactive)) ?? null;
  }, candidates);
  expect(
    point,
    'found a tap point that is plain content now and a link after the turn'
  ).not.toBeNull();
  await takeClicks(page);
  return point!;
}

/** Give the browser room to fire a delayed compatibility click, if it fires one. */
async function settleCompatibilityClick(page: Page) {
  await page.waitForTimeout(800);
}

test.describe('Paged reader interactions', () => {
  test('edge tap turns one page without clicking through to the new page', async ({
    authedPage,
    testUser,
  }) => {
    await openPagedReader(authedPage, testUser);
    expect(await pageLabel(authedPage)).toMatch(/^Page 1 of \d+$/);

    // Tap where page 2 keeps a link — the reported failure exactly.
    const { x, y } = await trapPoint(authedPage);
    await authedPage.touchscreen.tap(x, y);

    // Exactly one page turn...
    await expect(authedPage.locator('.paged-count')).toHaveText(/^Page 2 of \d+$/);
    await settleCompatibilityClick(authedPage);
    expect(await pageLabel(authedPage)).toMatch(/^Page 2 of \d+$/);

    // ...and the tap produced no click against the article at all, so nothing on
    // the page it revealed (nor the one it left) was activated. The reader answers
    // a link click with its own context menu, which is the visible form the report
    // takes on an engine that re-hit-tests the replayed click.
    const clicks = await takeClicks(authedPage);
    expect(clicks).toEqual([]);
    await expect(authedPage.locator('.link-menu')).toHaveCount(0);
  });

  test('tapping a link on the current page opens it instead of turning the page', async ({
    authedPage,
    testUser,
  }) => {
    await openPagedReader(authedPage, testUser);
    // Start on page 2 so a left-zone link tap has a page it could wrongly turn back to.
    await authedPage.getByRole('button', { name: 'Next page' }).click();
    await expect(authedPage.locator('.paged-count')).toHaveText(/^Page 2 of \d+$/);
    await settlePageTransform(authedPage);
    await takeClicks(authedPage);

    const link = await visibleLinkPoint(authedPage);
    await authedPage.touchscreen.tap(link.x, link.y);
    await settleCompatibilityClick(authedPage);

    expect(await pageLabel(authedPage)).toMatch(/^Page 2 of \d+$/);
    expect((await takeClicks(authedPage)).map((c) => c.href)).toContain(link.href);
    // The reader answers a link tap with its own context menu rather than a
    // navigation, and titles it with the link's text.
    await expect(authedPage.locator('.link-menu')).toContainText(link.text);
  });

  test('edge tap on the last page stays a native tap', async ({ authedPage, testUser }) => {
    await openPagedReader(authedPage, testUser);

    // Walk to the final page with the explicit pager, which is unaffected by the
    // touch path under test.
    const next = authedPage.getByRole('button', { name: 'Next page' });
    for (let i = 0; i < 200 && !(await next.isDisabled()); i++) {
      await next.click();
    }
    await expect(next).toBeDisabled();
    await settlePageTransform(authedPage);
    const lastLabel = await pageLabel(authedPage);
    await takeClicks(authedPage);

    const { x, y } = await nextZonePoint(authedPage);
    await authedPage.touchscreen.tap(x, y);
    await settleCompatibilityClick(authedPage);

    // Nothing to turn to, so the tap is left alone: the page is unchanged and the
    // browser's click still reaches the article (no blanket post-turn input lock).
    expect(await pageLabel(authedPage)).toBe(lastLabel);
    expect((await takeClicks(authedPage)).length).toBeGreaterThan(0);
  });

  // The Daily magazine embeds the same PagedView, so the gesture fix is shared —
  // this is the smoke test that the second consumer really gets it.
  test('daily magazine edge tap turns one page without clicking through', async ({
    authedPage,
    testUser,
  }) => {
    for (const [i, url] of [
      'https://example.com/daily/one',
      'https://example.org/daily/two',
    ].entries()) {
      await seedSavedArticle(testUser, {
        url,
        title: `Daily Paged Story ${i + 1}`,
        domain: new URL(url).hostname,
        contentType: 'article',
        content: pagedBody(),
        wordCount: 1200,
      });
    }

    await authedPage.goto('/home');
    await authedPage.getByRole('button', { name: 'Generate issue' }).click({ timeout: 15_000 });
    await expect(authedPage).toHaveURL(/\/daily$/);
    await expect(authedPage.locator('.issue-article')).toHaveCount(2, { timeout: 15_000 });

    await authedPage.getByTitle('Switch to paged view').locator('visible=true').click();
    const count = authedPage.locator('.paged-count');
    await expect(count).toHaveText(/^Page 1 of (?!1$)\d+$/, { timeout: 15_000 });
    await settlePageTransform(authedPage);
    await recordContentClicks(authedPage);

    const { x, y } = await nextZonePoint(authedPage);
    await authedPage.touchscreen.tap(x, y);

    await expect(count).toHaveText(/^Page 2 of \d+$/);
    await settleCompatibilityClick(authedPage);
    expect(await pageLabel(authedPage)).toMatch(/^Page 2 of \d+$/);
    expect(await takeClicks(authedPage)).toEqual([]);
  });
});
