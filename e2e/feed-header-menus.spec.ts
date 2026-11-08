import { test, expect } from './fixtures';
import { seedSubscription, seedFeedItems } from './seed';

// The feed header's Style and Filter buttons open menus hung under them (like
// the reader's Share and Style menus). Picks apply in place and leave the menu
// up; Escape folds an open section, then closes; a click outside closes.

const FEED = 'https://example.com/header-menus.xml';
const TITLE = 'A post for the header menus';

test.describe('Feed header menus', () => {
  test.beforeEach(async ({ authedPage: page, testUser }) => {
    await seedSubscription(testUser, { feedUrl: FEED, title: 'Header Menus Feed' });
    await seedFeedItems(FEED, [{ guid: 'header-menus-1', title: TITLE }], {
      title: 'Header Menus Feed',
      siteUrl: 'https://example.com',
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/feeds');
    await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Style: a font pick stays open, Escape closes and refocuses', async ({
    authedPage: page,
  }) => {
    const button = page.getByRole('button', { name: 'Toggle style' });
    await button.click();
    const menu = page.getByRole('dialog', { name: 'Style' });
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');

    await menu.getByRole('radio', { name: /Literata/ }).click();
    await expect(menu.getByRole('radio', { name: /Literata/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(menu).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('Filter: sort and show apply in place; Escape folds Sources, then closes', async ({
    authedPage: page,
  }) => {
    await page.getByRole('button', { name: 'Toggle filters' }).click();
    const menu = page.getByRole('dialog', { name: 'Filter' });
    await expect(menu).toBeVisible();

    await menu.getByRole('radio', { name: 'Oldest first' }).click();
    await expect(menu.getByRole('radio', { name: 'Oldest first' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    // Sort is a radio group: the arrows move the choice.
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('radio', { name: 'Newest first' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await menu.getByRole('radio', { name: 'All' }).click();
    await expect(menu.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu).toBeVisible();

    const sources = menu.getByRole('button', { name: /Sources/ });
    await sources.click();
    await expect(sources).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('checkbox', { name: 'Header Menus Feed' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sources).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // A click outside closes it too.
    await page.getByRole('button', { name: 'Toggle filters (changed)' }).click();
    await expect(menu).toBeVisible();
    await page.mouse.click(900, 700);
    await expect(menu).toHaveCount(0);
  });

  test("Escape over an overlay is the overlay's, and tabbing away closes the menu", async ({
    authedPage: page,
  }) => {
    const button = page.getByRole('button', { name: 'Toggle style' });
    await button.click();
    const menu = page.getByRole('dialog', { name: 'Style' });
    await expect(menu).toBeVisible();
    // Focus leaving the menu for the page puts it away.
    await menu.getByRole('radio', { checked: true }).focus();
    await page.getByRole('button', { name: 'Toggle filters' }).focus();
    await expect(menu).toHaveCount(0);

    // A stale open flag with no menu on screen doesn't claim Escape.
    await page.getByRole('button', { name: 'Toggle filters' }).click();
    await expect(page.getByRole('dialog', { name: 'Filter' })).toBeVisible();
    // Leave by the keyboard (2 is Queue): nothing closes the Filter flag on the way.
    await page.keyboard.press('2');
    await expect(page).not.toHaveURL(/\/feeds/);
    const prevented = await page.evaluate(() => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });
});
