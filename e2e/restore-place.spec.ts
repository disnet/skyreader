import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// A piece reopens straight at its saved place: one jump, not a glide down from
// the top through everything already read.

const TITLE = 'A Long Piece to Come Back To';

test('reopening a piece jumps to its place without scrolling there', async ({
  authedPage: page,
  testUser,
}) => {
  await seedSavedArticle(testUser, {
    url: 'https://return.example/long',
    title: TITLE,
    domain: 'return.example',
    contentType: 'article',
    content: Array.from(
      { length: 120 },
      (_, n) => `<p>Paragraph ${n} of a long piece about coming back to reading, at length.</p>`
    ).join(''),
    wordCount: 3000,
  });
  await page.goto('/saved');
  const openIt = () =>
    page.locator('.bookmark-title', { hasText: TITLE }).click({ timeout: 15_000 });
  const para = (n: number) =>
    page.locator('.reader-overlay .reader-body p', { hasText: `Paragraph ${n} of` }).first();

  await openIt();
  for (let i = 0; i < 40; i++) await page.keyboard.press('j');
  await expect(para(40)).toBeInViewport();
  await page.waitForTimeout(1500); // the place is saved
  await page.keyboard.press('Escape');
  await expect(page.locator('.reader-overlay')).toHaveCount(0);

  // Watch every frame's scroll offset while it reopens.
  await page.evaluate(() => {
    const w = window as unknown as { __offsets: number[] };
    w.__offsets = [];
    const sample = () => {
      const el = document.querySelector('.reader-overlay');
      if (el) w.__offsets.push(Math.round(el.scrollTop));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await openIt();
  await expect(para(40)).toBeInViewport();
  await page.waitForTimeout(1000);
  const offsets = await page.evaluate(
    () => (window as unknown as { __offsets: number[] }).__offsets
  );
  const final = offsets[offsets.length - 1];
  expect(final).toBeGreaterThan(0);
  // At most a jump or two on the way (a restore re-runs when the full body lands
  // after its description): a smooth scroll passes through dozens of offsets.
  const between = new Set(offsets.filter((o) => o > 0 && o !== final));
  expect(between.size).toBeLessThanOrEqual(2);
});
