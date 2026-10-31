import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// Settings → Import saves, end to end: a Pocket CSV goes in, its unread save
// lands in the Queue and its archived one in the Archive, with its tag.

const POCKET_CSV =
  'title,url,time_added,tags,status\n' +
  'Imported Unread Article,https://example.com/import-unread,1700000000,,unread\n' +
  'Imported Archived Article,https://example.com/import-archived,1690000000,history,archive\n';

test.describe('Import saves', () => {
  test('imports a Pocket export into the Queue and Archive', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    await authedPage.getByRole('button', { name: 'Import saves' }).click();

    await authedPage.locator('input[type="file"][accept*=".zip"]').setInputFiles({
      name: 'part_000000.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(POCKET_CSV),
    });
    await expect(
      authedPage.getByText('Found 2 articles from Pocket, 1 of them archived.')
    ).toBeVisible();
    await expect(authedPage.getByText('1 tag, kept as tags')).toBeVisible();

    const done = authedPage.waitForResponse((r) => r.url().includes('/api/saved/import'));
    await authedPage.getByRole('button', { name: 'Import 2 articles' }).click();
    expect((await done).status()).toBe(200);
    await expect(authedPage.getByText('Added to your Library')).toBeVisible();
    await authedPage.getByRole('button', { name: 'Done' }).click();

    await authedPage.goto('/saved');
    await expect(authedPage.getByText('Imported Unread Article')).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText('Imported Archived Article')).toHaveCount(0);

    await authedPage.getByRole('button', { name: 'Showing Inbox, newest first' }).click();
    await authedPage.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(authedPage.getByText('Imported Archived Article')).toBeVisible();
    await expect(authedPage.getByText('history')).toBeVisible();
  });

  test('imports only the ticked articles, all to the Inbox, off the Shelf', async ({
    authedPage,
  }) => {
    await authedPage.goto('/settings');
    await authedPage.getByRole('button', { name: 'Import saves' }).click();
    await authedPage.locator('input[type="file"][accept*=".zip"]').setInputFiles({
      name: 'part_000000.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(POCKET_CSV),
    });

    await authedPage.getByRole('checkbox', { name: /Imported Unread Article/ }).uncheck();
    await authedPage.getByText('All of them, to read next').click();
    await expect(authedPage.getByRole('radio', { name: /^Inbox/ })).toBeChecked();
    await authedPage.getByRole('checkbox', { name: /Also put them on your Shelf/ }).uncheck();

    const done = authedPage.waitForResponse((r) => r.url().includes('/api/saved/import'));
    await authedPage.getByRole('button', { name: 'Import 1 article' }).click();
    const request = (await done).request().postDataJSON();
    expect(request.shelf).toBe(false);
    expect(request.items).toEqual([
      expect.objectContaining({ url: 'https://example.com/import-archived', archived: false }),
    ]);
    await expect(authedPage.getByText('Added to your Library')).toBeVisible();
    await authedPage.getByRole('button', { name: 'Done' }).click();

    await authedPage.goto('/saved');
    await expect(authedPage.getByText('Imported Archived Article')).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.getByText('Imported Unread Article')).toHaveCount(0);
  });

  test('says how Readwise Reader’s Shortlist comes across', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    await authedPage.getByRole('button', { name: 'Import saves' }).click();
    await authedPage.locator('input[type="file"][accept*=".zip"]').setInputFiles({
      name: 'readwise.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'Title,URL,ID,Document tags,Saved date,Reading progress,Location,Seen\n' +
          'Shortlisted,https://example.com/shortlisted,1,[],2024-01-02 10:00:00+00:00,0,shortlist,True\n' +
          'Later,https://example.com/later,2,[],2024-01-01 10:00:00+00:00,0,later,True\n'
      ),
    });
    await expect(
      authedPage.getByText('1 article from your Readwise Shortlist: those new here are tagged')
    ).toBeVisible();
    // The Shortlist's tag isn't counted again as one of the reader's own.
    await expect(authedPage.getByText('kept as tags')).toHaveCount(0);
  });

  test('marks articles already in the Library, and can leave them out', async ({
    authedPage,
    testUser,
  }) => {
    // Saved with a tracking param: still the same article.
    await seedSavedArticle(testUser, {
      url: 'https://example.com/import-unread?utm_source=feed',
      title: 'Imported Unread Article',
    });
    await authedPage.goto('/settings');
    await authedPage.getByRole('button', { name: 'Import saves' }).click();
    await authedPage.locator('input[type="file"][accept*=".zip"]').setInputFiles({
      name: 'part_000000.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(POCKET_CSV),
    });

    await expect(authedPage.getByText('1 already in your Library')).toBeVisible();
    await expect(
      authedPage.getByRole('checkbox', { name: /Imported Unread Article .*Already saved/ })
    ).toBeChecked();
    await expect(
      authedPage.getByText('1 article already in your Library keeps its place and tags')
    ).toBeVisible();

    await authedPage.getByRole('button', { name: 'Untick the ones already saved' }).click();
    await expect(
      authedPage.getByRole('checkbox', { name: /Imported Unread Article/ })
    ).not.toBeChecked();
    await expect(authedPage.getByRole('button', { name: 'Import 1 article' })).toBeEnabled();
  });
});

// Kindle's My Clippings.txt: no URLs, only books and passages. Each book lands
// on the Shelf, its passages are its body, and each one is highlighted there.
const CLIPPINGS = [
  '﻿The Imported Book: A Subtitle (Writer, Ada)',
  '- Your Highlight on page 3 | Location 40-42 | Added on Monday, March 2, 2020 8:00:00 AM',
  '',
  'The first passage worth keeping.',
  '==========',
  'The Imported Book: A Subtitle (Writer, Ada)',
  '- Your Highlight on page 9 | Location 120-125 | Added on Tuesday, March 3, 2020 10:15:42 PM',
  '',
  'A later passage, with a note on it.',
  '==========',
  'The Imported Book: A Subtitle (Writer, Ada)',
  '- Your Note on page 9 | Location 125 | Added on Tuesday, March 3, 2020 10:16:00 PM',
  '',
  'My note.',
  '==========',
  '',
].join('\r\n');

test.describe('Import Kindle highlights', () => {
  test('puts each book on the Shelf with its passages highlighted', async ({ authedPage }) => {
    const shots = process.env.SCREENSHOT_DIR;
    await authedPage.goto('/settings');
    await authedPage.getByRole('button', { name: 'Import saves' }).click();
    await authedPage.locator('input[type="file"][accept*=".txt"]').setInputFiles({
      name: 'My Clippings.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(CLIPPINGS),
    });
    await expect(authedPage.getByText('Found 1 book from Kindle')).toBeVisible();
    await expect(
      authedPage.getByRole('checkbox', { name: /The Imported Book: A Subtitle .*Ada Writer · Book/ })
    ).toBeChecked();
    await expect(authedPage.getByText('2 highlights, attached to their books')).toBeVisible();
    if (shots) await authedPage.screenshot({ path: `${shots}/kindle-import-preview.png` });

    const done = authedPage.waitForResponse((r) => r.url().includes('/api/saved/import'));
    await authedPage.getByRole('button', { name: 'Import 1 book' }).click();
    const response = await done;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().source).toBe('kindle');
    await expect(authedPage.getByText('Added to your Library')).toBeVisible();
    await authedPage.getByRole('button', { name: 'Done' }).click();

    await authedPage.goto('/shelf');
    const book = authedPage.getByRole('button', { name: /The Imported Book/ }).first();
    await expect(book).toBeVisible({ timeout: 15_000 });
    if (shots) await authedPage.screenshot({ path: `${shots}/kindle-shelf.png` });
    await book.click();

    const marks = authedPage.locator('mark.highlight[data-highlight-id]');
    await expect(marks.first()).toBeVisible({ timeout: 15_000 });
    await expect(marks.filter({ hasText: 'The first passage worth keeping.' })).toHaveCount(1);
    await expect(marks.filter({ hasText: 'A later passage, with a note on it.' })).toHaveCount(1);
    if (shots) await authedPage.screenshot({ path: `${shots}/kindle-reader.png` });

    await authedPage.goto('/highlights');
    await expect(authedPage.getByText('A later passage, with a note on it.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.getByText('My note.')).toBeVisible();
    if (shots) await authedPage.screenshot({ path: `${shots}/kindle-highlights.png` });
  });
});
