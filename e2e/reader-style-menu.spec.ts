import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// The reader's Style button opens a menu under it (like Share and Save): fonts as
// radio rows and a size stepper. Picks apply at once and leave it up; Escape and
// a click outside put it away, and Escape doesn't take the reader with it.

const TITLE = 'A Piece To Restyle';
const body = Array.from(
  { length: 8 },
  (_, i) => `<p>Paragraph ${i + 1}. Enough words to give the reader something to set.</p>`
).join('');

test.describe('Reader Style menu', () => {
  test('picks apply in place, and Escape closes the menu, not the reader', async ({
    authedPage: page,
    testUser,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedSavedArticle(testUser, {
      url: 'https://example.com/style-menu',
      title: TITLE,
      domain: 'example.com',
      contentType: 'article',
      content: body,
      wordCount: 400,
    });
    await page.goto('/?saved=true');
    await page.getByText(TITLE).first().click({ timeout: 15_000 });

    const button = page.getByTitle('Font and text size').locator('visible=true');
    await button.click();
    const menu = page.getByRole('dialog', { name: 'Style' });
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');

    // A pick applies and the menu stays up.
    await menu.getByRole('radio', { name: /Literata/ }).click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('radio', { name: /Literata/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // Arrows move the choice, and the reader's own arrow shortcuts don't see them.
    const overlay = page.locator('.reader-overlay');
    const scrolled = () => overlay.evaluate((el) => el.scrollTop);
    const scrollBefore = await scrolled();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('radio', { name: /Mono/ })).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem('skyreader-preferences') ?? '{}').articleFont
        )
      )
      .toBe('mono');

    const size = menu.locator('[aria-live="polite"]');
    const before = Number(await size.textContent());
    await menu.getByLabel('Larger text').click();
    await expect.poll(async () => Number(await size.textContent())).toBeGreaterThan(before);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(overlay).toBeVisible();
    expect(await scrolled()).toBe(scrollBefore);
    await expect(button).toBeFocused();

    // A click outside puts it away too.
    await button.click();
    await expect(menu).toBeVisible();
    await page.mouse.click(700, 700);
    await expect(menu).toHaveCount(0);

    // And so does the button, a second time.
    await button.click();
    await expect(menu).toBeVisible();
    await button.click();
    await expect(menu).toHaveCount(0);
  });

  test('the phone sheet lays out the same rows, and its arrows move the font', async ({
    authedPage: page,
    testUser,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedSavedArticle(testUser, {
      url: 'https://example.com/style-sheet',
      title: TITLE,
      domain: 'example.com',
      contentType: 'article',
      content: body,
      wordCount: 400,
    });
    await page.goto('/?saved=true');
    await page.getByText(TITLE).first().click({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Style and actions' }).click();
    const fonts = page.getByRole('radiogroup', { name: 'Font' });
    await expect(fonts).toBeVisible();
    await fonts.getByRole('radio', { checked: true }).focus();
    await fonts.getByRole('radio', { name: /Serif/ }).click();
    await page.keyboard.press('ArrowDown');
    await expect(fonts.getByRole('radio', { name: /Literata/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
