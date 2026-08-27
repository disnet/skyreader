import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { seedSavedArticle, type TestUser } from './seed';

// Fullscreen paged reading is a touch surface, and the rule these tests pin down is
// that a *tap* is never a page turn: taps belong to the text (selection, links,
// highlights). Only a horizontal swipe and the bottom pager turn pages. That needs
// the real touch event path, so the context has touch and a phone-sized viewport
// (one column, many pages). Reduced motion turns pages instantly (see PagedView's
// prefers-reduced-motion rule), which keeps the coordinate math free of a
// mid-transition layout race.
test.use({ hasTouch: true, viewport: { width: 430, height: 860 }, reducedMotion: 'reduce' });

const ARTICLE_TITLE = 'A Long Paged Article';
const ARTICLE_URL = 'https://example.com/paged/long-article';

/**
 * Enough prose to guarantee many pages, with a wide link in every paragraph so a
 * tap that wrongly turned the page would visibly land on something else.
 */
function pagedBody(): string {
  const paragraphs = Array.from({ length: 60 }, (_, i) => {
    const href = `https://example.com/trap/${i}`;
    // Paragraph lengths cycle rather than repeat, so links don't land on the same
    // line of every page.
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
 * Record clicks that reach the paged column, in the capture phase — i.e. every
 * click the article would act on, including the one the browser replays after a
 * finished tap.
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

/** Switch reading modes through the control exposed at the current viewport. */
async function switchToPagedView(page: Page) {
  const mobileStyleButton = page
    .getByRole('button', { name: 'Style and actions' })
    .locator('visible=true');

  if (await mobileStyleButton.count()) {
    await mobileStyleButton.click({ timeout: 15_000 });
    const styleSheet = page.getByRole('dialog', { name: 'Style & Actions' });
    await expect(styleSheet).toBeVisible();
    await styleSheet.getByRole('button', { name: 'Pages', exact: true }).click();
    await styleSheet.getByRole('button', { name: 'Drag to dismiss' }).press('Enter');
    await expect(styleSheet).toBeHidden();
    return;
  }

  await page.getByTitle('Switch to paged view').locator('visible=true').click({ timeout: 15_000 });
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

  await switchToPagedView(page);

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
 * A point near the given horizontal edge of the viewport that is NOT over a link or
 * control on the current page — the plain reading area that used to be a page-turn
 * zone. Derived from `.paged-viewport` so it holds at any layout.
 */
async function edgePoint(page: Page, side: 'left' | 'right') {
  const point = await page.evaluate((edge) => {
    const viewport = document.querySelector('.paged-viewport');
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    const x = rect.left + rect.width * (edge === 'left' ? 0.15 : 0.85);
    const interactive = 'a, button, input, textarea, select, video, audio, iframe, [role="button"]';
    for (let fraction = 0.2; fraction <= 0.8; fraction += 0.05) {
      const y = rect.top + rect.height * fraction;
      const el = document.elementFromPoint(x, y);
      if (!el || el.closest(interactive)) continue;
      return { x, y };
    }
    return null;
  }, side);
  expect(point, `found a non-interactive point in the ${side} edge zone`).not.toBeNull();
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
 * Drag the paged column sideways across most of the viewport — well past the
 * paginator's commit threshold. Playwright's touchscreen only taps, so the gesture
 * is dispatched as a real touch sequence against `.paged-viewport`.
 */
async function swipe(page: Page, direction: 'left' | 'right') {
  await page.evaluate((dir) => {
    const viewport = document.querySelector<HTMLElement>('.paged-viewport');
    if (!viewport) throw new Error('no .paged-viewport to swipe on');
    const rect = viewport.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const from = rect.left + rect.width * (dir === 'left' ? 0.8 : 0.2);
    const travel = rect.width * 0.6 * (dir === 'left' ? -1 : 1);
    const target = document.elementFromPoint(from, y) ?? viewport;
    const fire = (type: string, x: number) => {
      const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y });
      const live = type === 'touchend' ? [] : [touch];
      viewport.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: live,
          targetTouches: live,
          changedTouches: [touch],
        })
      );
    };
    fire('touchstart', from);
    for (let step = 1; step <= 6; step++) fire('touchmove', from + (travel * step) / 6);
    fire('touchend', from + travel);
  }, direction);
}

/** Give the browser room to fire a delayed compatibility click, if it fires one. */
async function settleCompatibilityClick(page: Page) {
  await page.waitForTimeout(800);
}

interface DragPoints {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/**
 * Two points on the visible page that a mouse drag can select between. The rects
 * come from a Range over the prose text node (a block element's own
 * `getClientRects()` is per column fragment, not per line) and skip the link
 * every seeded paragraph opens with — pressing the mouse down on a link starts a
 * link drag instead of a selection.
 */
async function textDragPoints(page: Page): Promise<DragPoints> {
  const points = await page.evaluate(() => {
    const viewport = document.querySelector('.paged-viewport');
    if (!viewport) return null;
    const bounds = viewport.getBoundingClientRect();
    const onPage = (r: DOMRect) =>
      r.left >= bounds.left &&
      r.right <= bounds.right &&
      r.top >= bounds.top &&
      r.bottom <= bounds.bottom &&
      r.width > 60 &&
      r.height > 8;
    const plainText = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return !!el && !!el.closest('.paged-content') && !el.closest('a, button, mark.highlight');
    };
    for (const paragraph of document.querySelectorAll<HTMLElement>('.paged-content p')) {
      const prose = Array.from(paragraph.childNodes).find(
        (node): node is Text =>
          node.nodeType === Node.TEXT_NODE && (node.textContent?.trim().length ?? 0) > 100
      );
      if (!prose) continue;
      const range = document.createRange();
      range.selectNodeContents(prose);
      const lines = Array.from(range.getClientRects()).filter(onPage);
      if (lines.length < 2) continue;
      const first = lines[0];
      const last = lines[lines.length - 1];
      const from = { x: first.left + 6, y: first.top + first.height / 2 };
      // Keep the drag's end clear of the trailing edge zone: a selection focus
      // resting there is what arms the dwell auto-turn, and these tests want to
      // decide when the page turns.
      const to = {
        x: Math.max(last.left + 6, Math.min(last.right - 6, bounds.right - 60)),
        y: last.top + last.height / 2,
      };
      if (!plainText(from.x, from.y) || !plainText(to.x, to.y)) continue;
      return { from, to };
    }
    return null;
  });
  expect(points, 'found a paragraph on the current page to drag-select').not.toBeNull();
  return points!;
}

/** A point over plain prose on the visible page — no link, control or highlight. */
async function plainTextPoint(page: Page) {
  const point = await page.evaluate(() => {
    const viewport = document.querySelector('.paged-viewport');
    if (!viewport) return null;
    const bounds = viewport.getBoundingClientRect();
    for (let fx = 0.2; fx <= 0.8; fx += 0.1) {
      for (let fy = 0.2; fy <= 0.85; fy += 0.05) {
        const x = bounds.left + bounds.width * fx;
        const y = bounds.top + bounds.height * fy;
        const el = document.elementFromPoint(x, y);
        if (!el || !el.closest('.paged-content')) continue;
        if (el.closest('a, button, mark.highlight')) continue;
        return { x, y };
      }
    }
    return null;
  });
  expect(point, 'found plain prose on the current page').not.toBeNull();
  return point!;
}

/** Drag-select a run of prose on the page the reader is showing. */
async function dragSelect(page: Page, points: DragPoints) {
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 10 });
  await page.mouse.up();
}

interface SelectionSnapshot {
  text: string;
  focusOnPage: boolean;
}

/** What the live selection is, and whether its focus sits on the visible page. */
async function selectionSnapshot(page: Page): Promise<SelectionSnapshot | null> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const viewport = document.querySelector('.paged-viewport');
    if (!selection || selection.isCollapsed || !selection.rangeCount || !viewport) return null;
    const bounds = viewport.getBoundingClientRect();
    const focus = document.createRange();
    focus.setStart(selection.focusNode!, selection.focusOffset);
    focus.collapse(true);
    let rect = focus.getBoundingClientRect();
    // Collapsed ranges at a text boundary often report an empty rect. Match
    // the production geometry helper by measuring the preceding character so
    // this assertion checks where the browser will draw the focus handle.
    if (!rect.width && !rect.height && selection.focusNode?.nodeType === Node.TEXT_NODE) {
      const text = selection.focusNode as Text;
      const offset = Math.max(0, Math.min(selection.focusOffset - 1, text.length - 1));
      focus.setStart(text, offset);
      focus.setEnd(text, Math.min(offset + 1, text.length));
      rect = focus.getBoundingClientRect();
    }
    return {
      text: selection.toString(),
      focusOnPage: rect.right > bounds.left && rect.left < bounds.right,
    };
  });
}

test.describe('Paged reader interactions', () => {
  test('a tap in the right reading area never turns the page', async ({ authedPage, testUser }) => {
    await openPagedReader(authedPage, testUser);
    const label = await pageLabel(authedPage);
    expect(label).toMatch(/^Page 1 of \d+$/);

    const { x, y } = await edgePoint(authedPage, 'right');
    await authedPage.touchscreen.tap(x, y);
    await settleCompatibilityClick(authedPage);

    // Nothing paged, and the tap stayed native: the article still received the
    // click, so selection and in-text controls keep working.
    expect(await pageLabel(authedPage)).toBe(label);
    expect((await takeClicks(authedPage)).length).toBeGreaterThan(0);
  });

  test('a tap in the left reading area never turns back a page', async ({
    authedPage,
    testUser,
  }) => {
    await openPagedReader(authedPage, testUser);
    // Start on page 2 so a left-edge tap has a page it could wrongly turn back to.
    await authedPage.getByRole('button', { name: 'Next page' }).click();
    await expect(authedPage.locator('.paged-count')).toHaveText(/^Page 2 of \d+$/);
    await settlePageTransform(authedPage);
    await takeClicks(authedPage);

    const { x, y } = await edgePoint(authedPage, 'left');
    await authedPage.touchscreen.tap(x, y);
    await settleCompatibilityClick(authedPage);

    expect(await pageLabel(authedPage)).toMatch(/^Page 2 of \d+$/);
    expect((await takeClicks(authedPage)).length).toBeGreaterThan(0);
  });

  test('swiping turns pages in both directions', async ({ authedPage, testUser }) => {
    await openPagedReader(authedPage, testUser);
    const count = authedPage.locator('.paged-count');
    await expect(count).toHaveText(/^Page 1 of \d+$/);

    await swipe(authedPage, 'left');
    await expect(count).toHaveText(/^Page 2 of \d+$/);
    await settlePageTransform(authedPage);

    await swipe(authedPage, 'right');
    await expect(count).toHaveText(/^Page 1 of \d+$/);
  });

  test('tapping a link on the current page opens it', async ({ authedPage, testUser }) => {
    await openPagedReader(authedPage, testUser);
    const label = await pageLabel(authedPage);

    const link = await visibleLinkPoint(authedPage);
    await authedPage.touchscreen.tap(link.x, link.y);
    await settleCompatibilityClick(authedPage);

    expect(await pageLabel(authedPage)).toBe(label);
    expect((await takeClicks(authedPage)).map((c) => c.href)).toContain(link.href);
    // The reader answers a link tap with its own context menu rather than a
    // navigation, and titles it with the link's text.
    await expect(authedPage.locator('.link-menu')).toContainText(link.text);
  });

  // The Daily magazine embeds the same PagedView, so the gesture rules are shared —
  // this is the smoke test that the second consumer really gets them.
  test('daily magazine ignores edge taps and pages on swipe', async ({ authedPage, testUser }) => {
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

    await switchToPagedView(authedPage);
    const count = authedPage.locator('.paged-count');
    await expect(count).toHaveText(/^Page 1 of (?!1$)\d+$/, { timeout: 15_000 });
    await settlePageTransform(authedPage);
    await recordContentClicks(authedPage);

    const { x, y } = await edgePoint(authedPage, 'right');
    await authedPage.touchscreen.tap(x, y);
    await settleCompatibilityClick(authedPage);
    await expect(count).toHaveText(/^Page 1 of \d+$/);

    await swipe(authedPage, 'left');
    await expect(count).toHaveText(/^Page 2 of \d+$/);
  });
});

// The complaint this answers is "I get stuck on the page": a selection can't reach
// text that hasn't been turned to yet. Turning the page has to carry the selection
// with it — and it has to do that with the page-turn *animation running*, which is
// the default. Measured against the sliding page, one frame into a 340ms turn the
// old text is still on screen and the bridge decides there's nothing to do, so the
// motion setting is load-bearing for this test.
test.describe('Selection across page turns', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('a page turn carries a live selection onto the new page', async ({
    authedPage,
    testUser,
  }) => {
    await openPagedReader(authedPage, testUser);
    await dragSelect(authedPage, await textDragPoints(authedPage));

    const before = await selectionSnapshot(authedPage);
    expect(before, 'drag-selected some prose').not.toBeNull();
    expect(before!.text.length).toBeGreaterThan(10);
    expect(before!.focusOnPage).toBe(true);

    // The keyboard turn is the affordance that always works mid-selection —
    // clicking the pager would take focus and collapse the selection first.
    await authedPage.keyboard.press('ArrowRight');
    await expect(authedPage.locator('.paged-count')).toHaveText(/^Page 2 of \d+$/);
    await settlePageTransform(authedPage);

    const after = await selectionSnapshot(authedPage);
    expect(after, 'the selection survived the turn').not.toBeNull();
    // It grew forward across the page boundary...
    expect(after!.text.startsWith(before!.text)).toBe(true);
    expect(after!.text.length).toBeGreaterThan(before!.text.length);
    // ...and its end is back on screen, where the reader can keep dragging it.
    expect(after!.focusOnPage).toBe(true);
  });
});

test.describe('Adjusting a highlight', () => {
  test('a pointer drag adjusts in place and leaving never re-binds the next selection', async ({
    authedPage,
    testUser,
  }) => {
    await openPagedReader(authedPage, testUser);
    const marks = authedPage.locator('.paged-content mark.highlight');

    await dragSelect(authedPage, await textDragPoints(authedPage));
    await authedPage.getByRole('button', { name: 'Save private highlight' }).click();
    await expect(marks).toHaveCount(1);

    // Enter adjust mode, then think better of it and click away. The mark is
    // clicked through its first line box: an inline element wrapping several
    // lines has a bounding box whose centre isn't over the mark at all.
    const markPoint = await marks.first().evaluate((el) => {
      const line = el.getClientRects()[0];
      return { x: line.left + Math.min(8, line.width / 2), y: line.top + line.height / 2 };
    });
    await authedPage.mouse.click(markPoint.x, markPoint.y);
    await authedPage.getByRole('button', { name: 'Adjust highlight' }).click();
    const adjustBar = authedPage.getByText('Adjusting a highlight');
    await expect(adjustBar).toBeVisible();

    // A normal pointer drag starts by collapsing the programmatic selection on
    // mousedown. Adjust mode must survive that collapse until mouseup can see
    // the completed range, then update the existing id rather than creating an
    // overlapping second highlight.
    await dragSelect(authedPage, await textDragPoints(authedPage));
    await authedPage.getByRole('button', { name: 'Save adjustment' }).click();
    await expect(marks).toHaveCount(1);
    const adjustedId = await marks.first().getAttribute('data-highlight-id');

    const adjustedMarkPoint = await marks.first().evaluate((el) => {
      const line = el.getClientRects()[0];
      return { x: line.left + Math.min(8, line.width / 2), y: line.top + line.height / 2 };
    });
    await authedPage.mouse.click(adjustedMarkPoint.x, adjustedMarkPoint.y);
    await authedPage.getByRole('button', { name: 'Adjust highlight' }).click();
    await expect(adjustBar).toBeVisible();
    const elsewhere = await plainTextPoint(authedPage);
    await authedPage.mouse.click(elsewhere.x, elsewhere.y);
    await expect(adjustBar).toBeHidden();

    // A later, unrelated selection must create its own highlight rather than
    // silently moving the first one onto it.
    await authedPage.getByRole('button', { name: 'Next page' }).click();
    await expect(authedPage.locator('.paged-count')).toHaveText(/^Page 2 of \d+$/);
    await settlePageTransform(authedPage);
    await dragSelect(authedPage, await textDragPoints(authedPage));
    await authedPage.getByRole('button', { name: 'Save private highlight' }).click();

    await expect(marks).toHaveCount(2);
    const ids = await marks.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.highlightId)
    );
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(adjustedId);
  });
});
