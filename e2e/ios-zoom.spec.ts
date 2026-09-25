import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { seedSavedArticle, type TestUser } from './seed';
import { PHONE, expectNoZoomingFields } from './ios-zoom';

// iOS Safari zooms into any text field under 16px on focus (see ios-zoom.ts).
// Every field a reader can type into on a phone belongs in here: a page whose
// fields show on load goes in PAGES; one behind a tap gets its own test.
test.use(PHONE);

const PAGES = ['/feeds', '/settings', '/sources', '/discover', '/rooms'];

for (const path of PAGES) {
  test(`text fields on ${path} are at least 16px`, async ({ authedPage: page }) => {
    await page.goto(path);
    await expect(page.locator('input, textarea, select').first()).toBeVisible({ timeout: 15_000 });
    await expectNoZoomingFields(page, path);
  });
}

async function setArticleFontSize(page: Page, px: number) {
  await page.evaluate((size) => {
    const key = 'skyreader-preferences';
    const prefs = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...prefs, articleFontSize: size }));
  }, px);
}

async function openArticle(page: Page, user: TestUser) {
  await seedSavedArticle(user, {
    url: 'https://example.com/ios-zoom/article',
    title: 'A Small Print Article',
    domain: 'example.com',
    contentType: 'article',
    content: Array.from(
      { length: 8 },
      (_, i) =>
        `<p>Paragraph ${i} carries enough words that a tap in the middle of it lands on prose.</p>`
    ).join(''),
    wordCount: 120,
  });

  await page.goto('/?saved=true');
  await page.getByText('A Small Print Article').first().click({ timeout: 15_000 });
  await expect(page.locator('.reader-body p').first()).toBeVisible({ timeout: 15_000 });
}

// The note editor sizes its handwriting off the article (x0.9), so it clears
// 16px at the default 18px and zooms at anything under ~17.8px. Test the floor.
test('the margin note editor is at least 16px at the smallest article size', async ({
  authedPage: page,
  testUser,
}) => {
  await setArticleFontSize(page, 14);
  await openArticle(page, testUser);

  // Double-tap marks the paragraph; tapping the mark offers its note.
  const paragraph = (await page.locator('.reader-body p').nth(2).boundingBox())!;
  const x = paragraph.x + paragraph.width / 2;
  const y = paragraph.y + Math.min(paragraph.height / 2, 10);
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  const mark = page.locator('.reader-body mark.highlight').first();
  await expect(mark).toBeVisible();

  await page.waitForTimeout(400);
  await mark.tap();
  await page.getByRole('button', { name: 'Add a note' }).tap();

  await expect(page.locator('.marginalia-note textarea')).toBeVisible();
  await expectNoZoomingFields(page, 'the margin note editor');
});
