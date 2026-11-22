import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';
import type { Page } from '@playwright/test';

// The Desk: the few pieces open in one sitting, switched between from inside the
// reader. A switch swaps the open piece in place (no new history entry, so Back
// still closes the reader), and `` ` `` flips back to the piece open before.

const SHOTS = process.env.DESK_SHOTS;

const PIECES = [
  { title: 'The Slow Death of the Hyperlink', domain: 'links.example' },
  { title: "Links Are the Web's Footnotes", domain: 'footnotes.example' },
  { title: 'Against Infinite Scroll', domain: 'scroll.example' },
];

async function seedPieces(testUser: Parameters<typeof seedSavedArticle>[0]) {
  const now = Date.now();
  for (const [i, p] of PIECES.entries()) {
    await seedSavedArticle(testUser, {
      url: `https://${p.domain}/essay`,
      title: p.title,
      domain: p.domain,
      contentType: 'article',
      content: Array.from(
        { length: 40 },
        (_, n) => `<p>Paragraph ${n} of “${p.title}”, an essay about reading on the web.</p>`
      ).join(''),
      wordCount: 900,
      savedAt: now - (i + 1) * 60_000,
    });
  }
}

async function openFromQueue(page: Page, title: string) {
  await page.locator('.bookmark-title', { hasText: title }).click({ timeout: 15_000 });
  await expect(page.locator('.reader-overlay .reader-title')).toHaveText(title, {
    timeout: 15_000,
  });
}

test('pieces go on the Desk and switch in place; Back still closes the reader', async ({
  authedPage: page,
  testUser,
}) => {
  await seedPieces(testUser);
  await page.goto('/saved');
  const reader = page.locator('.reader-overlay');
  const deskButton = reader.locator('.reader-header').getByRole('button', { name: /^Desk/ });
  const panel = reader.getByRole('dialog', { name: 'Desk' });

  // Put two pieces on the Desk.
  await openFromQueue(page, PIECES[0].title);
  await deskButton.click();
  await panel.getByRole('button', { name: 'Put this on the Desk' }).click();
  await expect(deskButton).toHaveText(/Desk · 1/);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);

  await openFromQueue(page, PIECES[1].title);
  await deskButton.click();
  await panel.getByRole('button', { name: 'Put this on the Desk' }).click();
  await expect(deskButton).toHaveText(/Desk · 2/);
  await expect(panel.locator('.desk-item.current')).toContainText(PIECES[1].title);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desk-desktop.png` });

  // Switch to the first: same reader, its piece, its own ?read= key.
  const urlBefore = page.url();
  await panel.locator('.desk-item', { hasText: PIECES[0].title }).click();
  await expect(reader.locator('.reader-title')).toHaveText(PIECES[0].title);
  await expect(panel).toHaveCount(0);
  await expect.poll(() => page.url()).not.toBe(urlBefore);
  expect(new URL(page.url()).searchParams.get('read')).toBeTruthy();

  // A reload reopens what the switch put up.
  await page.reload();
  await expect(reader.locator('.reader-title')).toHaveText(PIECES[0].title, { timeout: 15_000 });

  // Back closes the reader: the switch didn't stack history.
  await page.goBack();
  await expect(reader).toHaveCount(0);
  await expect(page).toHaveURL(/\/saved$/);

  // The Desk outlives the reader, and taking a piece off works from the panel.
  await openFromQueue(page, PIECES[2].title);
  await expect(deskButton).toHaveText(/Desk · 2/);
  await deskButton.click();
  await panel.getByRole('button', { name: `Take “${PIECES[0].title}” off the Desk` }).click();
  await expect(deskButton).toHaveText(/Desk · 1/);
});

test('` flips between the last two pieces', async ({ authedPage: page, testUser }) => {
  await seedPieces(testUser);
  await page.goto('/saved');
  const title = page.locator('.reader-overlay .reader-title');

  await openFromQueue(page, PIECES[0].title);
  // Read partway in, so there's a place to come back to.
  const para = (n: number) =>
    page.locator('.reader-overlay .reader-body p', { hasText: `Paragraph ${n} of` }).first();
  for (let i = 0; i < 20; i++) await page.keyboard.press('j');
  await expect(para(20)).toBeInViewport();
  await page.keyboard.press('Escape');
  await openFromQueue(page, PIECES[1].title);

  // Nothing on the Desk, yet the panel offers the piece open before this one.
  await page.locator('.reader-header').getByRole('button', { name: /^Desk/ }).click();
  await expect(page.getByRole('dialog', { name: 'Desk' })).toContainText('Last open');
  await page.keyboard.press('Escape');

  await page.keyboard.press('`');
  await expect(title).toHaveText(PIECES[0].title);
  // It opens where it was left.
  await expect(para(20)).toBeInViewport();
  await expect(para(0)).not.toBeInViewport();
  await page.keyboard.press('`');
  await expect(title).toHaveText(PIECES[1].title);
  await expect(para(0)).toBeInViewport();
  await page.keyboard.press('`');
  await expect(title).toHaveText(PIECES[0].title);

  // Still one level deep.
  await page.goBack();
  await expect(page.locator('.reader-overlay')).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the Desk opens as a sheet from the bottom bar', async ({ authedPage: page, testUser }) => {
    await seedPieces(testUser);
    await page.goto('/saved');
    const bar = page.locator('.reader-bottom-bar');

    // A first piece goes on the Desk from Style & Actions.
    await openFromQueue(page, PIECES[0].title);
    await expect(bar.getByRole('button', { name: /^Desk/ })).toHaveCount(0);
    await bar.getByRole('button', { name: 'Style and actions' }).click();
    await page.getByRole('button', { name: /^Desk/ }).click();
    await page.getByRole('button', { name: 'Put this on the Desk' }).click();
    await page.keyboard.press('Escape');
    await page.goBack();

    await openFromQueue(page, PIECES[2].title);
    await bar.getByRole('button', { name: 'Desk, 1 piece' }).click();
    const row = page.locator('.desk-item', { hasText: PIECES[0].title });
    await expect(row).toBeVisible();
    if (SHOTS) {
      await page.waitForTimeout(500); // the sheet slides up
      await page.screenshot({ path: `${SHOTS}/desk-phone.png` });
    }
    await row.click();
    await expect(page.locator('.reader-overlay .reader-title')).toHaveText(PIECES[0].title);
  });
});

// Paged mode swaps pages, not scroll, so a switch must leave the other piece's
// page behind. (Reopening a paged piece at its saved page doesn't work in this
// stack yet, Desk or not, so that isn't asserted here.)
test('switching works in paged mode too', async ({ authedPage: page, testUser }) => {
  await seedPieces(testUser);
  await page.goto('/saved');
  const count = page.locator('.paged-count');
  const titled = (t: string) => expect(page).toHaveTitle(new RegExp(t.replace(/'/g, '.')));

  await openFromQueue(page, PIECES[0].title);
  await page.keyboard.press('Escape');
  await openFromQueue(page, PIECES[1].title);
  await page.locator('.reader-header').getByRole('button', { name: 'Pages' }).click();
  await expect(count).toHaveText(/^Page 1 of/);
  await page.keyboard.press('j');
  await expect(count).not.toHaveText(/^Page 1 of/);

  await page.keyboard.press('`');
  await titled(PIECES[0].title);
  await expect(count).toHaveText(/^Page 1 of/);
  await expect(page.locator('.reader-overlay .reader-body p').first()).toContainText(
    PIECES[0].title
  );
});
