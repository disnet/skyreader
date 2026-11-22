import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// Where a save came from. A link saved out of an article keeps that article
// (seeded here: the seeded session's scopes predate the save API, so a save
// made from the link menu is refused in this stack). The save says "From …",
// the article lists what was saved from it, and the Queue filters to one
// article's saves.

const SOURCE_URL = 'https://essays.example/how-cities-remember';
const SOURCE_TITLE = 'How Cities Remember';
const SHOTS = process.env.SAVED_FROM_SHOTS;

async function seedSession(testUser: Parameters<typeof seedSavedArticle>[0]) {
  const now = Date.now();
  await seedSavedArticle(testUser, {
    url: SOURCE_URL,
    title: SOURCE_TITLE,
    domain: 'essays.example',
    contentType: 'article',
    content:
      '<p>It starts with <a href="https://maps.example/old-street-names">the old street names</a>, ' +
      'goes on to <a href="https://atlas.example/lost-rivers">rivers paved over long ago</a> ' +
      'and ends <a href="mailto:author@essays.example">with a note</a>.</p>' +
      Array.from(
        { length: 6 },
        (_, i) => `<p>Paragraph ${i} of an essay about memory and streets.</p>`
      ).join(''),
    wordCount: 1200,
    savedAt: now - 60 * 60_000,
  });
  await seedSavedArticle(testUser, {
    url: 'https://maps.example/old-street-names',
    title: 'The Old Street Names',
    domain: 'maps.example',
    savedAt: now - 50 * 60_000,
    savedFromUrl: SOURCE_URL,
    savedFromTitle: SOURCE_TITLE,
  });
  await seedSavedArticle(testUser, {
    url: 'https://archive.example/plaques',
    title: 'A Census of Blue Plaques',
    domain: 'archive.example',
    savedAt: now - 45 * 60_000,
    // Another spelling of the same article.
    savedFromUrl: `${SOURCE_URL}/?utm_source=rss`,
    savedFromTitle: SOURCE_TITLE,
  });
  await seedSavedArticle(testUser, {
    url: 'https://unrelated.example/elsewhere',
    title: 'Something Saved Elsewhere',
    domain: 'unrelated.example',
    savedAt: now - 40 * 60_000,
  });
}

test('a save says where it came from, and the Queue filters to that article', async ({
  authedPage,
  testUser,
}) => {
  await seedSession(testUser);
  await authedPage.goto('/saved');

  const cardTitled = (title: string) =>
    authedPage
      .locator('.bookmark-card')
      .filter({ has: authedPage.locator('.bookmark-title', { hasText: title }) });
  const card = cardTitled('The Old Street Names');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole('link', { name: `From ${SOURCE_TITLE}` })).toBeVisible();
  await expect(cardTitled('Something Saved Elsewhere').locator('.meta-from')).toHaveCount(0);
  if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/queue-from.png` });

  await card.getByRole('link', { name: `From ${SOURCE_TITLE}` }).click();
  await expect(authedPage).toHaveURL(/\/saved\?from=/);
  await expect(authedPage.locator('.saved-from-banner')).toContainText(
    `Saved from ${SOURCE_TITLE}`
  );
  await expect(authedPage.locator('.bookmark-card')).toHaveCount(2);
  await expect(authedPage.getByText('Something Saved Elsewhere')).toHaveCount(0);
  if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/queue-filtered.png` });

  await authedPage.getByRole('link', { name: 'Show everything' }).click();
  await expect(authedPage.getByText('Something Saved Elsewhere')).toBeVisible();
});

test('an article lists the links saved from it, and each leads back', async ({
  authedPage,
  testUser,
}) => {
  await seedSession(testUser);
  await authedPage.goto('/saved');
  await authedPage.locator('.bookmark-title', { hasText: SOURCE_TITLE }).click({ timeout: 15_000 });
  const reader = authedPage.locator('.reader-overlay');
  await expect(reader).toBeVisible({ timeout: 15_000 });

  const list = reader.locator('.saved-from-here');
  await expect(list.getByRole('heading')).toHaveText('2 links you saved from this');
  await list.scrollIntoViewIfNeeded();
  if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/article-end.png` });

  // Into one of them, over the article: Back returns.
  await list.getByRole('button', { name: /The Old Street Names/ }).click();
  await expect(reader.locator('.reader-title')).toHaveText('The Old Street Names');
  const from = reader.locator('.reader-saved-from');
  await expect(from).toHaveText(`From ${SOURCE_TITLE}`);
  if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/reader-from.png` });

  // And back to the article it came from, which is a save of its own.
  await from.getByRole('link').click();
  await expect(reader.locator('.reader-title')).toHaveText(SOURCE_TITLE);
  await authedPage.goBack();
  await expect(reader.locator('.reader-title')).toHaveText('The Old Street Names');
  await authedPage.goBack();
  await expect(reader.locator('.reader-title')).toHaveText(SOURCE_TITLE);
});

test('the article lists all its links, saved ones marked, and saves one from there', async ({
  authedPage,
  testUser,
}) => {
  await seedSession(testUser);
  // The seeded session can't reach the extractor or the save API in this stack,
  // so both answer here; what's checked is what the reader sends and shows.
  await authedPage.route('**/api/extract', (route) =>
    route.fulfill({
      json: {
        title: 'Rivers Paved Over',
        author: null,
        description: null,
        content: '<p>Under the streets.</p>',
        domain: 'atlas.example',
        image: null,
        published: null,
        wordCount: 3,
      },
    })
  );
  let posted: Record<string, unknown> | null = null;
  await authedPage.route('**/api/saved', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted = route.request().postDataJSON();
    return route.fulfill({
      json: {
        uri: `at://${testUser.did}/app.skyreader.feed.saved/${posted!.rkey}`,
        savedAt: new Date().toISOString(),
        savedFromUrl: posted!.savedFromUrl,
        savedFromTitle: posted!.savedFromTitle,
      },
    });
  });

  await authedPage.goto('/saved');
  await authedPage.locator('.bookmark-title', { hasText: SOURCE_TITLE }).click({ timeout: 15_000 });
  const reader = authedPage.locator('.reader-overlay');
  const toggle = reader.getByRole('button', { name: /All links in this article/ });
  await expect(toggle).toHaveText(/2 · 1 saved/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  const rows = reader.locator('.link-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('the old street names');
  await expect(rows.nth(0).getByText('Saved')).toBeVisible();
  const river = rows.nth(1);
  await river.scrollIntoViewIfNeeded();
  if (SHOTS) await authedPage.screenshot({ path: `${SHOTS}/all-links.png` });

  await river.getByRole('button', { name: /Save rivers paved over/ }).click();
  await expect(river.getByText('Saved')).toBeVisible();
  await expect(toggle).toHaveText(/2 · 2 saved/);
  expect(posted).toMatchObject({
    url: 'https://atlas.example/lost-rivers',
    savedFromUrl: SOURCE_URL,
    savedFromTitle: SOURCE_TITLE,
  });
});
