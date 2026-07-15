import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { seedSavedArticle, type TestUser } from './seed';

const ARTICLES = [
  {
    url: 'https://example.com/magazine/first',
    title: 'The First Magazine Story',
    author: "Ada O'Reader",
    description: "Ada's first dispatch",
    // Long enough that, on a mobile viewport, the reader can scroll the *second*
    // article's top above the active-article line (so scroll-driven active
    // tracking is actually exercised, not stuck on this first article).
    content:
      '<p>The first article has a paragraph that can be highlighted from the magazine reader.</p><p>Its second paragraph makes the saved copy unmistakable.</p>' +
      Array.from(
        { length: 14 },
        (_, i) =>
          `<p>Filler paragraph ${i + 1} adds enough height to this first story that the reader has real scroll range on a phone-sized viewport, so turning to the next story is a meaningful scroll.</p>`
      ).join(''),
  },
  {
    url: 'https://example.org/magazine/second',
    title: 'The Second Magazine Story',
    author: 'Grace Reader',
    description: 'A distinct second dispatch',
    content:
      '<p>The second article appears in the same continuous issue.</p><p>This is distinct content for the later story.</p>',
  },
] as const;

async function seedMagazine(user: TestUser) {
  for (const article of ARTICLES) {
    await seedSavedArticle(user, {
      ...article,
      domain: new URL(article.url).hostname,
      contentType: 'article',
      wordCount: 200,
    });
  }
}

async function openMagazineFromHome(page: Page) {
  await page.goto('/home');
  // Magazines are now durable, explicitly-generated issues: the Home card offers
  // "Generate issue" (frozen from the saved pile) which, once minted, exposes an
  // "Open magazine" link. The card only renders after saves hydrate, so a visible
  // Generate button means the seeded articles are present.
  const generate = page.getByRole('button', { name: 'Generate issue' });
  await expect(generate).toBeVisible({ timeout: 15_000 });
  await generate.click();
  const openLink = page.getByRole('link', { name: 'Open magazine' });
  await expect(openLink).toBeVisible({ timeout: 15_000 });
  await openLink.click();
  await expect(page).toHaveURL(/\/daily$/);
  await expect(page.getByRole('heading', { name: 'Daily magazine', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Preparing your issue')).not.toBeVisible();
}

test.describe('Daily magazine reader', () => {
  test('opens from Home without a refresh and keeps saved-reader features', async ({
    authedPage,
    testUser,
  }) => {
    await seedMagazine(testUser);
    await openMagazineFromHome(authedPage);

    // The magazine is a reader surface, not the normal view-navigation header.
    await expect(authedPage.locator('.nav-dropdown')).toHaveCount(0);
    await expect(authedPage.locator('button[aria-haspopup="listbox"]')).toHaveCount(0);

    await expect(authedPage.locator('.issue-article')).toHaveCount(2);
    for (const article of ARTICLES) {
      await expect(authedPage.getByRole('heading', { name: article.title })).toBeVisible();
      await expect(
        authedPage.getByText(article.content.match(/<p>(.*?)<\/p>/)?.[1] ?? '')
      ).toBeVisible();
    }

    await expect(authedPage.getByRole('button', { name: 'Share to your linkblog' })).toHaveCount(2);

    const firstParagraph = authedPage.locator('#article-1 .article-body p').first();
    const paragraphText = await firstParagraph.textContent();
    await firstParagraph.dblclick();
    await expect(authedPage.locator('#article-1 mark.highlight')).toHaveText(paragraphText ?? '');
  });

  test('uses fixed reader controls without overflow on a mobile viewport', async ({
    authedPage,
    testUser,
  }) => {
    await seedMagazine(testUser);
    await authedPage.setViewportSize({ width: 390, height: 844 });
    await openMagazineFromHome(authedPage);

    const bottomBar = authedPage.locator('.reader-bottom-bar');
    await expect(bottomBar).toBeVisible();
    await expect(bottomBar.locator('button[title^="Back"]')).toBeVisible();
    await expect(bottomBar.getByTitle('Contents')).toBeVisible();
    // The magazine reader's chrome acts on the issue, not the article being read,
    // so per-article tagging is intentionally absent (ReaderChrome showTag={false}).
    await expect(bottomBar.locator('button[title^="Tag"]')).toHaveCount(0);
    await expect(bottomBar.getByTitle('Style & Actions')).toBeVisible();

    const chromeLayout = await bottomBar.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        position: getComputedStyle(element).position,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
      };
    });
    expect(chromeLayout.position).toBe('fixed');
    expect(chromeLayout.left).toBeGreaterThanOrEqual(0);
    expect(chromeLayout.right).toBeLessThanOrEqual(390);
    expect(chromeLayout.bottom).toBeLessThanOrEqual(844);

    const overflow = await authedPage.evaluate(() => {
      const reader = document.querySelector<HTMLElement>('.daily-reader');
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        readerWidth: reader?.scrollWidth ?? 0,
        readerClientWidth: reader?.clientWidth ?? 0,
      };
    });
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
    expect(overflow.readerWidth).toBeLessThanOrEqual(overflow.readerClientWidth + 1);

    const secondArticle = authedPage.locator('#article-2');
    const secondUrl = await secondArticle.locator('a.original-link').getAttribute('href');
    expect(secondUrl).toBeTruthy();
    await secondArticle.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await authedPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await authedPage.evaluate(() => {
      const reader = document.querySelector<HTMLElement>('.daily-reader');
      reader?.scrollBy(0, -24);
    });
    await authedPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(bottomBar).toBeVisible();
    // The scroll-driven "active article" only switches once the target's top rises
    // above the reader's ~28%-of-viewport line. Wait for that so the Open-in-browser
    // assertion below reflects the article actually being read.
    await expect(secondArticle).toHaveClass(/\bactive\b/, { timeout: 5_000 });

    await authedPage.evaluate(() => {
      Object.defineProperty(window, '__openedMagazineUrl', {
        configurable: true,
        writable: true,
        value: '',
      });
      window.open = ((url?: string | URL) => {
        (window as unknown as Window & { __openedMagazineUrl: string }).__openedMagazineUrl =
          String(url);
        return null;
      }) as typeof window.open;
    });
    await bottomBar.getByTitle('Style & Actions').click();
    const actions = authedPage.getByRole('dialog', { name: 'Style & Actions' });
    await expect(actions).toBeVisible();
    await actions.getByRole('button', { name: 'Open in browser' }).click();
    const openedUrl = await authedPage.evaluate(
      () => (window as Window & { __openedMagazineUrl?: string }).__openedMagazineUrl
    );
    expect(openedUrl).toBe(secondUrl);
  });
});
