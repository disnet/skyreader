import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { makeSupporter, seedSavedArticle } from './seed';
import { makePdf, type Placed } from '../frontend/src/routes/dev/_harness/pdfFixture';

// A saved PDF reads as reflowed text, and flips to its original pages (drawn by
// PDF.js) and back. The original's bytes come from GET /api/saved/<rkey>/file,
// which is stubbed here: a real upload needs the pdf-extractor Worker and R2.

const TITLE = 'A Paper About Attention';
const BODY = `<section data-pdf-page="1"><h2>Introduction</h2>${Array.from(
  { length: 6 },
  (_, i) => `<p>Reflowed paragraph ${i + 1} of the paper, set as ordinary text.</p>`
).join('')}</section>`;

function pdfBytes(): Buffer {
  const pages: Placed[][] = [1, 2, 3].map((p) => [
    [72, 720, 20, `Page ${p} heading`],
    [72, 680, 11, `Original text on page ${p}.`],
  ]);
  return Buffer.from(makePdf(pages));
}

test.describe('PDF original view', () => {
  test('flips between the reflowed text and the original pages', async ({
    authedPage,
    testUser,
  }) => {
    await makeSupporter(testUser);
    const rkey = await seedSavedArticle(testUser, {
      url: '',
      title: TITLE,
      source: 'upload',
      contentType: 'pdf',
      content: BODY,
      wordCount: 60,
    });
    let fileRequests = 0;
    await authedPage.route(`**/api/saved/${rkey}/file`, (route) => {
      fileRequests++;
      return route.fulfill({ body: pdfBytes(), contentType: 'application/pdf' });
    });
    await authedPage.evaluate(() => localStorage.removeItem('skyreader-pdf-view'));

    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });

    const reader = authedPage.locator('.reader-body');
    // Text first: the reflow.
    const toggle = authedPage.getByRole('group', { name: 'Show this PDF as' });
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(reader.getByText('Reflowed paragraph 1')).toBeVisible();
    expect(fileRequests).toBe(0);

    await toggle.getByRole('button', { name: 'Original' }).click();
    await expect(authedPage.locator('.pdf-page')).toHaveCount(3, { timeout: 15_000 });
    await expect(authedPage.locator('.pdf-page canvas').first()).toBeVisible();
    await expect(authedPage.locator('.textLayer').first()).toContainText('Page 1 heading');
    await expect(reader.getByText('Reflowed paragraph 1')).toHaveCount(0);

    // The choice sticks: reopening the reader comes back to the pages.
    await authedPage.reload();
    await expect(authedPage.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 15_000 });

    await authedPage
      .getByRole('group', { name: 'Show this PDF as' })
      .getByRole('button', { name: 'Text' })
      .click();
    await expect(reader.getByText('Reflowed paragraph 1')).toBeVisible();
    await expect(authedPage.locator('.pdf-page')).toHaveCount(0);
  });

  test('a highlight made on either view shows on the other', async ({ authedPage, testUser }) => {
    await makeSupporter(testUser);
    // The pages carry the reflow's own sentences, as an extracted PDF's would.
    const sentences = [1, 2, 3, 4].map(
      (i) => `Sentence ${i} of the paper is about attention and nothing else.`
    );
    const rkey = await seedSavedArticle(testUser, {
      url: '',
      title: TITLE,
      source: 'upload',
      contentType: 'pdf',
      content: `<section data-pdf-page="1">${sentences.map((t) => `<p>${t}</p>`).join('')}</section>`,
      wordCount: 50,
    });
    const pdf = Buffer.from(makePdf([sentences.map((t, i): Placed => [72, 700 - i * 40, 11, t])]));
    await authedPage.route(`**/api/saved/${rkey}/file`, (route) =>
      route.fulfill({ body: pdf, contentType: 'application/pdf' })
    );
    await authedPage.evaluate(() => localStorage.setItem('skyreader-pdf-view', 'original'));

    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
    const toggle = authedPage.getByRole('group', { name: 'Show this PDF as' });

    // On the pages: drag across most of the second sentence, then Highlight.
    const line = authedPage.locator('.textLayer span', { hasText: 'Sentence 2' });
    await expect(line).toBeVisible({ timeout: 15_000 });
    const box = (await line.boundingBox())!;
    await authedPage.mouse.move(box.x + 2, box.y + box.height / 2);
    await authedPage.mouse.down();
    await authedPage.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
    await authedPage.mouse.up();
    await authedPage.getByRole('button', { name: 'Save private highlight' }).click();
    await expect(authedPage.locator('.pdf-mark')).toHaveCount(1);

    // The same passage is marked in the text.
    await toggle.getByRole('button', { name: 'Text' }).click();
    const reader = authedPage.locator('.reader-body');
    await expect(reader.locator('mark.highlight')).toContainText('Sentence 2 of the paper');

    // And the other way: a paragraph highlighted in the text (double-click)…
    await reader.getByText('Sentence 4').dblclick();
    await expect(reader.locator('mark.highlight')).toHaveCount(2);

    // …is marked on the pages, on its own line.
    await toggle.getByRole('button', { name: 'Original' }).click();
    await expect(authedPage.locator('.pdf-mark')).toHaveCount(2, { timeout: 15_000 });
    const sentence4 = (await authedPage
      .locator('.textLayer span', { hasText: 'Sentence 4' })
      .boundingBox())!;
    const marks = await authedPage
      .locator('.pdf-mark')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    expect(marks.some((top) => Math.abs(top - sentence4.y) < 4)).toBe(true);

    // A tap on a mark opens its toolbar; removing it there clears it from the pages.
    const first = (await authedPage.locator('.pdf-mark').first().boundingBox())!;
    await authedPage.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
    await authedPage.getByRole('button', { name: 'Remove highlight' }).click();
    await expect(authedPage.locator('.pdf-mark')).toHaveCount(1);
  });

  test("the PDF's links jump between pages, and back", async ({ authedPage, testUser }) => {
    await makeSupporter(testUser);
    const rkey = await seedSavedArticle(testUser, {
      url: '',
      title: TITLE,
      source: 'upload',
      contentType: 'pdf',
      content: BODY,
      wordCount: 60,
    });
    const pages: Placed[][] = [1, 2, 3, 4].map((p) => [
      [72, 720, 20, `Page ${p} heading`],
      [72, 400, 11, `Halfway down page ${p}.`],
    ]);
    pages[0].push([72, 680, 11, 'See page 4'], [200, 680, 11, 'Project site']);
    const pdf = Buffer.from(
      makePdf(pages, {}, [
        [
          { rect: [70, 676, 140, 692], page: 3, top: 412 },
          { rect: [198, 676, 270, 692], url: 'https://example.com/project' },
        ],
      ])
    );
    await authedPage.route(`**/api/saved/${rkey}/file`, (route) =>
      route.fulfill({ body: pdf, contentType: 'application/pdf' })
    );
    await authedPage.evaluate(() => localStorage.setItem('skyreader-pdf-view', 'original'));

    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });

    const web = authedPage.locator('.pdf-links a[href="https://example.com/project"]');
    await expect(web).toHaveAttribute('target', '_blank', { timeout: 15_000 });

    // The internal link lands on its destination: page 4, halfway down.
    await authedPage.locator('.pdf-links a[data-page="4"]').click();
    const halfway = authedPage.locator('.textLayer span', { hasText: 'Halfway down page 4.' });
    await expect(halfway).toBeInViewport();
    await expect(authedPage.locator('.pdf-page-count')).toHaveText('4 / 4');

    // And the toolbar offers the way back to where the reader was.
    await authedPage.getByRole('button', { name: 'Back to page 1' }).click();
    await expect(authedPage.locator('.pdf-links a[data-page="4"]')).toBeInViewport();
    await expect(authedPage.getByRole('button', { name: /^Back to page/ })).toHaveCount(0);
  });

  test('opens where it was left, on another device too', async ({
    authedPage,
    testUser,
    browser,
  }) => {
    await makeSupporter(testUser);
    const rkey = await seedSavedArticle(testUser, {
      url: '',
      title: TITLE,
      source: 'upload',
      contentType: 'pdf',
      content: BODY,
      wordCount: 60,
    });
    const pages: Placed[][] = [1, 2, 3, 4, 5, 6, 7, 8].map((p) => [
      [72, 720, 20, `Page ${p} heading`],
      [72, 680, 11, `Original text on page ${p}.`],
    ]);
    const pdf = Buffer.from(makePdf(pages));
    const open = async (page: Page) => {
      await page.route(`**/api/saved/${rkey}/file`, (route) =>
        route.fulfill({ body: pdf, contentType: 'application/pdf' })
      );
      await page.evaluate(() => localStorage.setItem('skyreader-pdf-view', 'original'));
      await page.goto('/saved');
      await page.getByText(TITLE).first().click({ timeout: 15_000 });
      await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 15_000 });
    };

    await open(authedPage);
    await expect(authedPage.locator('.pdf-page-count')).toHaveText('1 / 8');

    // Read down to page 6; the place is sent to the server once the scrolling stops.
    const sent = authedPage.waitForRequest(
      (req) => req.url().endsWith('/api/labels') && req.postData()?.includes('"pdfPlace"') === true
    );
    await authedPage.locator('.pdf-page[data-page="6"]').scrollIntoViewIfNeeded();
    await expect(authedPage.locator('.pdf-page-count')).toHaveText('6 / 8');
    const body = JSON.parse((await sent).postData() ?? '{}');
    expect(body.props.page).toBe(6);

    // Another device (no local cache, same account) opens it on page 6.
    const other = await browser.newContext({
      storageState: await authedPage.context().storageState(),
    });
    try {
      const otherPage = await other.newPage();
      await otherPage.goto('/');
      await open(otherPage);
      await expect(otherPage.locator('.pdf-page-count')).toHaveText('6 / 8', { timeout: 15_000 });
    } finally {
      await other.close();
    }
  });

  test('a web article has no PDF toggle', async ({ authedPage, testUser }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/plain-article',
      title: 'A Plain Article',
      content: '<p>Just a web page.</p>',
    });
    await authedPage.goto('/saved');
    await authedPage.getByText('A Plain Article').first().click({ timeout: 15_000 });
    await expect(authedPage.locator('.reader-body').getByText('Just a web page.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.getByRole('group', { name: 'Show this PDF as' })).toHaveCount(0);
  });
});

test.describe('PDF original view on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 400, height: 800 } });

  test('a pinch zooms the pages, not the app', async ({ authedPage, testUser }) => {
    await makeSupporter(testUser);
    const rkey = await seedSavedArticle(testUser, {
      url: '',
      title: TITLE,
      source: 'upload',
      contentType: 'pdf',
      content: BODY,
      wordCount: 60,
    });
    await authedPage.route(`**/api/saved/${rkey}/file`, (route) =>
      route.fulfill({ body: pdfBytes(), contentType: 'application/pdf' })
    );
    await authedPage.evaluate(() => {
      localStorage.setItem('skyreader-pdf-view', 'original');
      localStorage.removeItem('skyreader-pdf-zoom');
    });
    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
    const first = authedPage.locator('.pdf-page').first();
    await expect(first.locator('canvas')).toBeVisible({ timeout: 15_000 });
    const fitted = (await first.boundingBox())!.width;

    // Two fingers spreading from 100px apart to 200px, over the page.
    const cdp = await authedPage.context().newCDPSession(authedPage);
    const box = (await first.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = Math.min(box.y + box.height / 2, 500);
    const fingers = (apart: number) => [
      { x: cx - apart / 2, y: cy, id: 1 },
      { x: cx + apart / 2, y: cy, id: 2 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(100) });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: fingers(100 + i * 10),
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect(authedPage.locator('.pdf-fit')).toHaveText('200%');
    await expect.poll(async () => (await first.boundingBox())!.width).toBeGreaterThan(fitted * 1.9);
    // The app itself never zoomed.
    expect(await authedPage.evaluate(() => window.visualViewport?.scale)).toBe(1);
    // The zoom is remembered for this PDF.
    expect(
      await authedPage.evaluate(
        (key) => JSON.parse(localStorage.getItem('skyreader-pdf-zoom') ?? '{}')[key],
        rkey
      )
    ).toBe(2);

    // A pinch whose second finger lands off the pages (on the toolbar) still
    // zooms them: two fingers closing to half as far apart.
    const bar = (await authedPage.locator('.pdf-toolbar').boundingBox())!;
    const onBar = { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2, id: 2 };
    const onPage = (apart: number) => ({ x: onBar.x, y: onBar.y - apart, id: 1 });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [onPage(200)],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [onPage(200), onBar],
    });
    // (The pinch starts from the first move, at 195px apart; 95px is half that.)
    for (let i = 1; i <= 21; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [onPage(200 - i * 5), onBar],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(authedPage.locator('.pdf-fit')).toHaveText('100%');
    expect(await authedPage.evaluate(() => window.visualViewport?.scale)).toBe(1);
  });
});
