import { test, expect } from './fixtures';
import { seedFollowLinks, seedSavedArticle } from './seed';

// From your follows (docs/plans/FOLLOWS_LINKS_PLAN.md) is a source, not a page:
// the links your Bluesky follows share arrive as rows of a channel, read and
// marked read like any other river item. /following resolves to that channel
// (making it the first time) or, without the timeline permission, to the ask
// on Manage Sources, which never goes through the app-wide re-login banner.

const HOUR = 60 * 60 * 1000;

test.describe('From your follows', () => {
  test('asks for the timeline permission on Manage Sources, not the app banner', async ({
    authedPage,
  }) => {
    await authedPage.goto('/following');
    await expect(authedPage).toHaveURL(/\/sources#follows/, { timeout: 15_000 });
    const row = authedPage.locator('#follows');
    await expect(row.getByText('Links from people you follow')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Allow' })).toBeVisible();
    await expect(authedPage.locator('.scope-upgrade-banner')).toHaveCount(0);
  });

  test('makes a channel of them, newest first, read like everything else', async ({
    authedPage,
    testUser,
  }) => {
    await seedFollowLinks(testUser, [
      {
        url: 'https://example.com/fresh',
        sharerDid: 'did:plc:sam',
        sharerName: 'Sam',
        title: 'Fresh Piece',
        ageMs: 1 * HOUR,
      },
      {
        url: 'https://example.com/popular',
        sharerDid: 'did:plc:maya',
        sharerName: 'Maya',
        title: 'Popular Piece',
        text: 'Worth your whole afternoon.',
        ageMs: 2 * HOUR,
      },
      {
        url: 'https://example.com/popular',
        sharerDid: 'did:plc:ben',
        sharerName: 'Ben',
        ageMs: 3 * HOUR,
      },
      {
        url: 'https://example.com/old',
        sharerDid: 'did:plc:kat',
        sharerName: 'Kat',
        title: 'Old Piece',
        ageMs: 40 * HOUR,
      },
    ]);

    await authedPage.goto('/following');
    await expect(authedPage).toHaveURL(/\/feeds\?view=/, { timeout: 15_000 });
    await expect(
      authedPage.locator('.sidebar').getByText('From your follows', { exact: true })
    ).toBeVisible();

    // Dated by first share: Popular was first shared three hours ago.
    const titles = authedPage.locator('.article-list .article-title');
    await expect(titles).toHaveText(['Fresh Piece', 'Popular Piece', 'Old Piece']);
    await expect(
      authedPage.locator('.article-list .follows-pill', { hasText: 'Maya +1' })
    ).toHaveAttribute('title', 'Maya and Ben shared this');

    // Marking one read is an ordinary read label, so it holds across a reload.
    const marked = authedPage.waitForResponse(
      (r) => r.url().includes('/api/reading/mark-read') && r.ok()
    );
    await authedPage
      .locator('.article-item', { hasText: 'Fresh Piece' })
      .locator('.read-toggle')
      .click();
    await marked;

    await authedPage.reload();
    await expect(titles).toHaveText(['Popular Piece', 'Old Piece'], { timeout: 15_000 });

    // Coming back through /following finds the channel rather than making another.
    await authedPage.goto('/following');
    await expect(authedPage).toHaveURL(/\/feeds\?view=/, { timeout: 15_000 });
    await expect(
      authedPage.locator('.sidebar').getByText('From your follows', { exact: true })
    ).toHaveCount(1);
  });

  test('asks once, in Everything, whether to add them there', async ({ authedPage, testUser }) => {
    await seedFollowLinks(testUser, [
      {
        url: 'https://example.com/everything',
        sharerDid: 'did:plc:maya',
        sharerName: 'Maya',
        title: 'Everything Piece',
      },
    ]);

    await authedPage.goto('/feeds');
    const intro = authedPage.locator('section.follows-intro');
    await expect(intro).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText('Everything Piece')).toHaveCount(0);

    const saved = authedPage.waitForResponse(
      (r) => r.url().includes('/api/v2/following-links/settings') && r.ok()
    );
    await intro.getByRole('button', { name: 'Add them to Everything' }).click();
    await saved;
    await expect(intro).toHaveCount(0);
    await expect(authedPage.locator('.article-list .article-title')).toHaveText([
      'Everything Piece',
    ]);

    // Answered for the account: not asked again, and still on after a reload.
    await authedPage.reload();
    await expect(authedPage.locator('.article-list .article-title')).toHaveText(
      ['Everything Piece'],
      { timeout: 15_000 }
    );
    await expect(intro).toHaveCount(0);

    // Manage Sources turns it back off.
    await authedPage.goto('/sources#follows');
    const toggle = authedPage.getByRole('checkbox', { name: 'Show them in Everything too' });
    await expect(toggle).toBeChecked();
    const off = authedPage.waitForResponse(
      (r) => r.url().includes('/api/v2/following-links/settings') && r.ok()
    );
    await toggle.uncheck();
    await off;
    await authedPage.goto('/feeds');
    await expect(authedPage.getByText('Everything Piece')).toHaveCount(0);
    await expect(intro).toHaveCount(0);
  });

  test('puts the most-shared links on Home', async ({ authedPage, testUser }) => {
    await seedFollowLinks(testUser, [
      {
        url: 'https://example.com/home-lane',
        sharerDid: 'did:plc:maya',
        sharerName: 'Maya Ortiz',
        title: 'Lane Piece',
      },
      {
        url: 'https://example.com/week-old',
        sharerDid: 'did:plc:kat',
        sharerName: 'Kat',
        title: 'Week-old Piece',
        ageMs: 4 * 24 * HOUR,
      },
    ]);
    // A library to draw lanes from; an empty one gets the first-run Home instead.
    await seedSavedArticle(testUser, { url: 'https://example.com/saved', title: 'A Saved Piece' });
    await authedPage.goto('/home');
    await expect(
      authedPage.getByRole('heading', { name: 'Shared by people you follow' })
    ).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText('Lane Piece')).toBeVisible();
    await expect(authedPage.getByText('Maya shared')).toBeVisible();
    // The lane looks back a week.
    await expect(authedPage.getByText('Week-old Piece')).toBeVisible();

    // "View all" is the channel.
    await authedPage
      .getByRole('region', { name: 'Shared by people you follow' })
      .getByRole('link', { name: 'View all' })
      .click();
    await expect(authedPage).toHaveURL(/\/feeds\?view=/, { timeout: 15_000 });
    await expect(authedPage.locator('.article-list .article-title')).toHaveText([
      'Lane Piece',
      'Week-old Piece',
    ]);
  });

  test('asks on Home when an account with a library has not allowed it', async ({
    authedPage,
    testUser,
  }) => {
    // An account from before the feature: saves, lanes, no timeline permission.
    await seedSavedArticle(testUser, { url: 'https://example.com/saved', title: 'A Saved Piece' });
    await authedPage.goto('/home');
    const ask = authedPage.getByRole('region', { name: 'New: links from people you follow' });
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await expect(ask.getByRole('button', { name: 'Allow access' })).toBeVisible();
    await expect(authedPage.getByText('A Saved Piece').first()).toBeVisible();

    // "Not now" hides the section; it stays hidden on the next visit.
    await ask.getByRole('button', { name: 'Not now' }).click();
    await expect(ask).toHaveCount(0);
    await authedPage.reload();
    await expect(authedPage.getByText('A Saved Piece').first()).toBeVisible({ timeout: 15_000 });
    await expect(ask).toHaveCount(0);
  });

  test("leads a new account's Home with what its follows share", async ({
    authedPage,
    testUser,
  }) => {
    await seedFollowLinks(testUser, [
      {
        url: 'https://example.com/first-read',
        sharerDid: 'did:plc:maya',
        sharerName: 'Maya Ortiz',
        title: 'First Read',
        text: 'Start with this one.',
      },
    ]);
    await authedPage.goto('/home');
    await expect(authedPage.getByRole('heading', { name: 'Welcome to Skyreader' })).toBeVisible({
      timeout: 15_000,
    });
    const follows = authedPage.getByRole('region', { name: 'Shared by people you follow' });
    await expect(follows.getByText('First Read')).toBeVisible({ timeout: 15_000 });
    await expect(follows.getByText('Maya Ortiz shared this')).toBeVisible();
    await expect(follows.getByText('“Start with this one.”')).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Add a site or RSS feed' })).toBeVisible();
  });

  test("leads an article's Discussion with the people you follow", async ({
    authedPage,
    testUser,
  }) => {
    const url = 'https://example.com/discussed';
    await seedSavedArticle(testUser, {
      url,
      title: 'A Discussed Piece',
      content: '<p>' + 'Words worth reading. '.repeat(60) + '</p>',
      wordCount: 180,
    });
    await seedFollowLinks(testUser, [
      {
        url,
        sharerDid: 'did:plc:maya',
        sharerName: 'Maya',
        text: 'The part about margins is the best bit.',
      },
      { url, sharerDid: 'did:plc:ben', sharerName: 'Ben', kind: 'repost', ageMs: 2 * HOUR },
    ]);

    await authedPage.goto('/?saved=true');
    await authedPage.getByText('A Discussed Piece').first().click({ timeout: 15_000 });

    const discussion = authedPage.locator('section.reader-discussion');
    await discussion.scrollIntoViewIfNeeded();
    // Maya said something, so she's a row with her words and the mark.
    const row = discussion.locator('li.entry', { hasText: 'Maya' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('You follow')).toBeVisible();
    await expect(row.getByText('The part about margins is the best bit.')).toBeVisible();
    // Ben only reposted: no words of his own, so he's in the linked-by line.
    await expect(discussion.locator('.also-linked')).toContainText('Ben');
    // No network's backlinks found either share, but the count still says two:
    // the headline counts the rows the stream shows.
    await expect(discussion.getByText('2 references across the Atmosphere')).toBeVisible();
  });
});
