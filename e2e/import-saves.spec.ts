import { test, expect } from './fixtures';

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
      authedPage.getByText('1 article from your Readwise Shortlist, tagged “shortlist”')
    ).toBeVisible();
  });
});
