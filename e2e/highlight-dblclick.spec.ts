import { test, expect, type Page } from './fixtures';
import { seedSavedArticle, type TestUser } from './seed';

// Double-clicking a paragraph with a mouse highlights the whole paragraph. The
// second click of the pair also makes the browser select a word, and that
// click's `mouseup` checks the selection a moment later to offer a toolbar.
// When the check ran before the paragraph's marks were drawn (the marks go on
// at the next frame, the check after 10ms), it found the word still selected
// and offered to highlight it too: one double-click, two highlights.

const ARTICLE_TITLE = 'A Double Clicked Article';
const ARTICLE_URL = 'https://example.com/highlight-dblclick/article';

function body(): string {
  return Array.from(
    { length: 12 },
    (_, i) =>
      `<p>Paragraph ${i} of the double click article keeps enough words on the ` +
      `line that a click in the middle of it lands squarely on prose and nothing else at all.</p>`
  ).join('');
}

async function openReader(page: Page, user: TestUser) {
  await seedSavedArticle(user, {
    url: ARTICLE_URL,
    title: ARTICLE_TITLE,
    domain: 'example.com',
    contentType: 'article',
    content: body(),
    wordCount: 300,
  });

  await page.goto('/?saved=true');
  await page.getByText(ARTICLE_TITLE).first().click({ timeout: 15_000 });
  await expect(page.locator('.reader-body p').first()).toBeVisible({ timeout: 15_000 });
}

/**
 * Hold every frame back past the mouseup's 10ms selection check, the order a
 * real display can produce, so the race these tests guard against always loses.
 */
async function holdFrames(page: Page) {
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const caf = window.cancelAnimationFrame.bind(window);
    const frames = new Map<number, number>();
    window.requestAnimationFrame = (cb) => {
      const id = window.setTimeout(() => frames.set(id, raf(cb)), 30);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      window.clearTimeout(id);
      const frame = frames.get(id);
      if (frame !== undefined) caf(frame);
    };
  });
}

const marks = (page: Page) => page.locator('.reader-body mark.highlight');

test('double-clicking a paragraph makes one highlight and no word toolbar', async ({
  authedPage: page,
  testUser,
}) => {
  await holdFrames(page);
  await openReader(page, testUser);

  const paragraph = page.locator('.reader-body p').nth(2);
  const box = (await paragraph.boundingBox())!;
  await page.mouse.dblclick(box.x + 40, box.y + Math.min(box.height / 2, 10));

  await expect(marks(page).first()).toHaveText(/^Paragraph 2 of the double click article/);
  // Past the selection check and the repaint.
  await page.waitForTimeout(300);
  const ids = await marks(page).evaluateAll(
    (els) => new Set(els.map((el) => (el as HTMLElement).dataset.highlightId)).size
  );
  expect(ids).toBe(1);
  await expect(page.locator('.highlight-popover')).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
});

// The third press of a triple-click selects the paragraph the double-click just
// highlighted. That's the highlight (its own toolbar, from clicking it), not a
// selection to offer highlighting again.
test('triple-clicking a paragraph makes one highlight and no selection toolbar', async ({
  authedPage: page,
  testUser,
}) => {
  await holdFrames(page);
  await openReader(page, testUser);

  const paragraph = page.locator('.reader-body p').nth(2);
  const box = (await paragraph.boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + Math.min(box.height / 2, 10), { clickCount: 3 });

  await expect(marks(page).first()).toHaveText(/^Paragraph 2 of the double click article/);
  await page.waitForTimeout(300);
  const ids = await marks(page).evaluateAll(
    (els) => new Set(els.map((el) => (el as HTMLElement).dataset.highlightId)).size
  );
  expect(ids).toBe(1);
  await expect(page.locator('.highlight-popover.with-steps')).toHaveCount(0);
});
