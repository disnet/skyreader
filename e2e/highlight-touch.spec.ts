import { test, expect, type Page } from './fixtures';
import { seedSavedArticle, type TestUser } from './seed';

// Double-tap-to-highlight-a-paragraph is a touch gesture, so it needs the real
// touch event path and a phone-sized viewport.
test.use({ hasTouch: true, viewport: { width: 430, height: 860 } });

const ARTICLE_TITLE = 'A Double Tapped Article';
const ARTICLE_URL = 'https://example.com/highlight-touch/article';

function body(): string {
  return Array.from(
    { length: 20 },
    (_, i) =>
      `<p>Paragraph ${i} of the double tap article keeps enough words on the ` +
      `line that a tap in the middle of it lands squarely on prose and nothing else at all.</p>`
  ).join('');
}

/** The opening words of paragraph `n`, so a mark can be identified by what it covers. */
function paragraphOpening(n: number): string {
  return `Paragraph ${n} of the double tap article`;
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
 * Two taps in the same spot, inside the 300ms the handler allows. Aimed near the
 * top of the paragraph so a tall block still gets hit on its first line.
 */
async function doubleTap(page: Page, paragraph: number) {
  const box = (await page.locator('.reader-body p').nth(paragraph).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 10);
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
}

/** Leave a stretch of text selected, the way a word iOS selected stays selected. */
async function selectWordIn(page: Page, paragraph: number) {
  await page.evaluate((n) => {
    const p = document.querySelectorAll('.reader-body p')[n] as HTMLElement;
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.firstChild!, 9);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, paragraph);
}

const marks = (page: Page) => page.locator('.reader-body mark.highlight');

/** Let a pending `requestAnimationFrame` repaint of the marks run. */
async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

test('double-tap highlights the paragraph', async ({ authedPage: page, testUser }) => {
  await openReader(page, testUser);

  await doubleTap(page, 2);

  await expect(marks(page)).toHaveCount(1);
  // The removal this guards against repaints on a `requestAnimationFrame`, so
  // settle two frames before asserting — otherwise the mark is still in the DOM
  // and the assertion passes against a highlight that is about to vanish.
  await settleFrames(page);
  await expect(marks(page)).toHaveCount(1);
  await expect(marks(page).first()).toHaveText(new RegExp(`^${paragraphOpening(2)}`));
});

test('double-tapping the same paragraph again removes the highlight', async ({
  authedPage: page,
  testUser,
}) => {
  await openReader(page, testUser);

  await doubleTap(page, 2);
  await expect(marks(page)).toHaveCount(1);

  // Past the 300ms pair window, so this is a fresh double tap and not a triple.
  await page.waitForTimeout(400);
  await doubleTap(page, 2);
  await expect(marks(page)).toHaveCount(0);
});

// iOS leaves a word selected (with its callout) long after the gesture that made
// it — including through the taps that dismiss it. Treating any live selection as
// proof that a tap belongs to a selection gesture therefore zeroed the double-tap
// seed on every tap that followed one, and the gesture stopped working entirely.
test('double-tap still highlights while an unrelated selection is live', async ({
  authedPage: page,
  testUser,
}) => {
  await openReader(page, testUser);

  await selectWordIn(page, 8);
  await doubleTap(page, 2);

  // The removal this guards against repaints on a `requestAnimationFrame`, so
  // settle two frames before asserting — otherwise the mark is still in the DOM
  // and the assertion passes against a highlight that is about to vanish.
  await settleFrames(page);
  await expect(marks(page)).toHaveCount(1);
  await expect(marks(page).first()).toHaveText(new RegExp(`^${paragraphOpening(2)}`));
});

// iPadOS replays a finished double tap as a full emulated mouse sequence —
// mousedown, mouseup, click and `dblclick` — about 20ms after the `touchend`,
// and does it even though that touchend was `preventDefault()`ed. Measured on
// iPadOS 26 with the on-device event log. Because `highlightParagraph` toggles,
// an unguarded `dblclick` handler removes the highlight the touch path just
// made, and the gesture looks like it does nothing at all. Playwright's
// synthetic taps don't emit that echo, so the test has to.
test('the dblclick iOS replays after a double tap does not undo the highlight', async ({
  authedPage: page,
  testUser,
}) => {
  await openReader(page, testUser);

  await doubleTap(page, 2);
  await expect(marks(page)).toHaveCount(1);

  await page.evaluate(() => {
    const p = document.querySelectorAll('.reader-body p')[2] as HTMLElement;
    const { left, top, width, height } = p.getBoundingClientRect();
    p.dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: left + width / 2,
        clientY: top + Math.min(height / 2, 10),
      })
    );
  });

  // The removal this guards against repaints on a `requestAnimationFrame`, so
  // settle two frames before asserting — otherwise the mark is still in the DOM
  // and the assertion passes against a highlight that is about to vanish.
  await settleFrames(page);
  await expect(marks(page)).toHaveCount(1);
  await expect(marks(page).first()).toHaveText(new RegExp(`^${paragraphOpening(2)}`));
});
