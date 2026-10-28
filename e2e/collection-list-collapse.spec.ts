import { test, expect } from './fixtures';
import { seedShelfCollection } from './seed';

// A long collection list under Library shows five (the pinned ones, topped up
// from the top) and the open one, with "Show N more" for the rest; the choice holds across
// reloads and is shared by the sidebar and the mobile switcher.

const SHOTS = process.env.SHOTS_DIR;

async function seedTen(testUser: Parameters<typeof seedShelfCollection>[0]) {
  for (let n = 1; n <= 10; n++) {
    await seedShelfCollection(testUser, {
      id: `3collapse00${String(n).padStart(2, '0')}`,
      name: `Reading list ${n}`,
      position: n,
      pinned: n === 9,
    });
  }
}

test('the sidebar shows a few collections and the rest on request', async ({
  authedPage,
  testUser,
}) => {
  await seedTen(testUser);
  await authedPage.setViewportSize({ width: 1280, height: 900 });
  await authedPage.goto('/shelf?collection=3collapse0007');

  const rows = authedPage.locator('.collection-item');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  // The pinned one (9) and the first four make five; the open one (7) shows
  // too. All in the list's order.
  await expect(rows).toHaveText([1, 2, 3, 4, 7, 9].map((n) => new RegExp(`Reading list ${n}$`)));
  const more = authedPage.getByRole('button', { name: 'Show 4 more' });
  await expect(more).toBeVisible();
  if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/sidebar-collapsed-desktop.png` });

  await more.click();
  await expect(rows).toHaveCount(10);
  if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/sidebar-expanded-desktop.png` });

  // Held across a reload.
  await authedPage.reload();
  await expect(rows).toHaveCount(10, { timeout: 15_000 });
  await authedPage.getByRole('button', { name: 'Show less' }).click();
  await expect(rows).toHaveCount(6);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 393, height: 852 }, hasTouch: true });

  test('the switcher collapses the list too, and search looks through all of it', async ({
    authedPage,
    testUser,
  }) => {
    await seedTen(testUser);
    await authedPage.goto('/shelf');
    await expect(authedPage.getByRole('button', { name: 'Switch feed' })).toBeVisible({
      timeout: 15_000,
    });
    await authedPage.getByRole('button', { name: 'Switch feed' }).click();

    const sheet = authedPage.locator('.feed-switcher');
    const collections = sheet.locator('button.nav-item', { hasText: /Reading list/ });
    await expect(collections).toHaveCount(5); // 1–4 and the pinned 9
    const more = sheet.getByRole('button', { name: 'Show 5 more' });
    await expect(more).toBeVisible();
    if (SHOTS) {
      await authedPage.waitForTimeout(600); // the sheet's slide-up
      await authedPage.screenshot({ path: `${SHOTS}/switcher-collapsed-phone.png` });
    }

    await more.click();
    await expect(collections).toHaveCount(10);
    await expect(sheet.getByRole('button', { name: 'Show less' })).toBeVisible();
    if (SHOTS) {
      await authedPage.waitForTimeout(600); // the sheet's slide-up
      await authedPage.screenshot({ path: `${SHOTS}/switcher-expanded-phone.png` });
    }
    await sheet.getByRole('button', { name: 'Show less' }).click();
    await expect(collections).toHaveCount(5);

    // A search finds a hidden one, and drops the toggle.
    await sheet.getByRole('textbox', { name: 'Search feeds' }).fill('list 8');
    await expect(collections).toHaveText([/Reading list 8\s*$/]);
    await expect(sheet.getByRole('button', { name: /^Show / })).toHaveCount(0);
  });
});
