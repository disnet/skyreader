import { test, expect } from './fixtures';
import { seedItemLabel, seedSavedArticle } from './seed';

// Earlier readings: a piece reopened after a long gap shows what was marked the
// first time as a fainter layer, says which reading this is, and lets the
// reader carry a passage into this reading ("Still matters").
const SHOTS = process.env.REREAD_SHOTS;
const DAY = 24 * 60 * 60 * 1000;

const quote = (exact: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
  id: exact.slice(0, 8).replace(/\W/g, '') + createdAt,
  selector: { type: 'TextQuoteSelector', exact },
  createdAt,
  ...extra,
});

async function seedReread(testUser: Parameters<typeof seedSavedArticle>[0]) {
  const rkey = await seedSavedArticle(testUser, {
    url: 'https://example.com/second-look',
    title: 'A Second Look',
    domain: 'example.com',
    content:
      '<p>The first time through, the argument seemed to be about speed.</p>' +
      '<p>Coming back, it reads as an argument about attention and what it costs.</p>' +
      '<p>Some passages only open on a later reading.</p>',
  });
  const uri = `at://${testUser.did}/app.skyreader.feed.saved/${rkey}`;
  const first = Date.now() - 90 * DAY;
  const second = Date.now() - DAY;
  await seedItemLabel(testUser, {
    itemKey: uri,
    itemType: 'saved',
    label: 'highlights',
    props: JSON.stringify({
      highlights: [
        quote('the argument seemed to be about speed', first + DAY, {
          note: 'Is it, though?',
        }),
        quote('Some passages only open on a later reading', first + DAY + 1000),
        quote('what it costs', second + 1000),
      ],
    }),
  });
  await seedItemLabel(testUser, {
    itemKey: uri,
    itemType: 'saved',
    label: 'readings',
    props: JSON.stringify({ readings: [{ startedAt: first }, { startedAt: second }] }),
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`a reread shows the earlier marks fainter, and Still matters carries one over (${scheme})`, async ({
    authedPage,
    testUser,
  }) => {
    test.skip(scheme === 'dark' && !SHOTS, 'dark only for screenshots');
    await authedPage.emulateMedia({ colorScheme: scheme });
    await seedReread(testUser);
    await authedPage.goto('/saved');
    await authedPage.locator('.bookmark-title', { hasText: 'A Second Look' }).click();

    await expect(authedPage.getByText(/Your second reading · first read/)).toBeVisible({
      timeout: 15_000,
    });
    const earlier = authedPage.locator('mark.highlight[data-reading="earlier"]');
    await expect(earlier).toHaveCount(2);
    await expect(authedPage.locator('mark.highlight:not([data-reading])')).toHaveCount(1);
    await expect(authedPage.getByText('Then and now')).toBeAttached();
    if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/reread-${scheme}.png` });

    // Hide and show the earlier layer.
    await authedPage.getByRole('button', { name: 'Hide earlier marks' }).click();
    await expect(earlier).toHaveCount(0);
    // Hidden, not gone: their notes step out too, but a tap on the passage
    // still finds the highlight rather than making a second one.
    await expect(authedPage.getByText('Is it, though?')).toHaveCount(0);
    await authedPage.locator('mark.highlight[data-reading="hidden"]').first().click();
    await expect(authedPage.getByRole('button', { name: 'Still matters' })).toBeVisible();
    await authedPage.locator('.reader-title').click();
    await authedPage.getByRole('button', { name: 'Show earlier marks' }).click();
    await expect(earlier).toHaveCount(2);

    // Still matters: the passage joins this reading at full ink.
    await authedPage
      .locator('mark.highlight', { hasText: 'Some passages only open' })
      .first()
      .click();
    const still = authedPage.getByRole('button', { name: 'Still matters' });
    await expect(still).toBeVisible();
    await expect(authedPage.getByText('Marked in', { exact: false })).toBeVisible();
    if (SHOTS) await authedPage.waitForTimeout(400);
    if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/still-matters-${scheme}.png` });
    await still.click();
    await expect(earlier).toHaveCount(1);
    await expect(authedPage.getByText(/1 still mattered/)).toBeAttached();
  });
}

test('the first opening of a new reading starts at the top, and can go back', async ({
  authedPage,
  testUser,
}) => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => `<p>Paragraph ${i + 1} of a long piece worth a second look.</p>`
  ).join('');
  const rkey = await seedSavedArticle(testUser, {
    url: 'https://example.com/long-return',
    title: 'A Long Return',
    domain: 'example.com',
    content: paragraphs,
  });
  const uri = `at://${testUser.did}/app.skyreader.feed.saved/${rkey}`;
  const then = Date.now() - 60 * DAY;
  await seedItemLabel(testUser, {
    itemKey: uri,
    itemType: 'saved',
    label: 'highlights',
    props: JSON.stringify({ highlights: [quote('Paragraph 3 of a long piece', then)] }),
  });
  await seedItemLabel(testUser, {
    itemKey: uri,
    itemType: 'saved',
    label: 'readProgress',
    props: JSON.stringify({ paragraphIndex: 30, totalParagraphs: 40, lastReadAt: then }),
  });

  await authedPage.goto('/saved');
  await authedPage.locator('.bookmark-title', { hasText: 'A Long Return' }).click();
  const back = authedPage.getByRole('button', { name: /Back to where you were/ });
  await expect(back).toBeVisible({ timeout: 15_000 });
  await expect(authedPage.getByText(/Your second reading/)).toBeVisible();
  await expect(
    authedPage.locator('.reader-body').getByText('Paragraph 1 of a long piece')
  ).toBeInViewport();

  await back.click();
  await expect(
    authedPage.locator('.reader-body').getByText('Paragraph 31 of a long piece')
  ).toBeInViewport();
  await expect(back).toHaveCount(0);
});
