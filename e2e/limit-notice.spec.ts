import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The upgrade prompt shown when a reader hits a plan limit. Two things have to
// hold everywhere it appears: it names the wall honestly and offers a route to
// /supporter, and it says "park", never "remove" — over-limit feeds are kept,
// not destroyed, and copy that says otherwise tells readers to throw away data.
//
// The limit is forced through the client-side pre-check (auth.user.limits in
// localStorage) rather than by editing backend config, so the suite never
// depends on a temporary edit to tier-limits.ts being reverted.

/** Rewrite the stored plan so the app believes this reader is at/over a cap. */
async function setPlan(
  page: Page,
  plan: { tier?: string; maxSubscriptions?: number; maxUrlSavesPerMonth?: number }
) {
  await page.evaluate((p) => {
    const raw = localStorage.getItem('skyreader-auth');
    const parsed = raw ? JSON.parse(raw) : { user: {} };
    parsed.user = {
      ...parsed.user,
      tier: p.tier ?? parsed.user.tier,
      limits: {
        maxSubscriptions: p.maxSubscriptions ?? 100,
        maxMirroredSubscriptions: 1000,
        maxUrlSavesPerMonth: p.maxUrlSavesPerMonth ?? 100,
      },
    };
    localStorage.setItem('skyreader-auth', JSON.stringify(parsed));
  }, plan);
  await page.reload();
}

/** Open the Add RSS Feed modal via the sidebar's "Add source" control. */
async function openAddFeedModal(page: Page) {
  await page.getByRole('button', { name: 'Add source' }).click();
  await page.locator('.menu-item', { hasText: 'Add RSS Feed' }).click();
}

test.describe('Limit notice', () => {
  test('a free reader at the feed cap is told to park, and offered the upgrade', async ({
    authedPage,
  }) => {
    await setPlan(authedPage, { maxSubscriptions: 0 });

    await openAddFeedModal(authedPage);

    const notice = authedPage.locator('.limit-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });

    // Says what happened, and what to do about it, in the parking model.
    await expect(notice).toContainText('active limit');
    await expect(notice).toContainText('Park a feed');
    // The old copy told readers to destroy feeds. It must not come back.
    await expect(notice).not.toContainText('Remove some feeds');

    // And offers exactly one route out.
    const upgrade = notice.getByRole('link', { name: 'Become a Supporter' });
    await expect(upgrade).toBeVisible();
    await expect(upgrade).toHaveAttribute('href', '/supporter');
  });

  // The upsell is a link, and the modals that carry it are rendered by the
  // persistent shell — so before Modal watched for navigation, taking the offer
  // landed the reader on /supporter with the dialog still over the page.
  test('taking the offer leaves the modal behind', async ({ authedPage }) => {
    await setPlan(authedPage, { maxSubscriptions: 0 });

    await openAddFeedModal(authedPage);
    const notice = authedPage.locator('.limit-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.locator('.modal-backdrop')).toBeVisible();

    await notice.getByRole('link', { name: 'Become a Supporter' }).click();

    await expect(authedPage).toHaveURL(/\/supporter/);
    await expect(authedPage.locator('.modal-backdrop')).toHaveCount(0);
  });

  test('a Supporter at their own ceiling gets the fact with no sales pitch', async ({
    authedPage,
  }) => {
    await setPlan(authedPage, { tier: 'supporter', maxSubscriptions: 0 });

    await openAddFeedModal(authedPage);

    const notice = authedPage.locator('.limit-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('active limit');
    await expect(notice.getByRole('link', { name: 'Become a Supporter' })).toHaveCount(0);
  });
});
