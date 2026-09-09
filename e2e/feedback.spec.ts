import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const board = {
  spaceUrl: 'https://userinput.app/s/did:plc:space/space-rkey',
  total: 3,
  complete: true,
  types: [
    { value: 'bug', label: 'Bug' },
    { value: 'feature', label: 'Feature request' },
    { value: 'question', label: 'Question' },
  ],
  posts: [
    {
      uri: 'at://did:plc:alice/app.userinput.discussion/first',
      url: 'https://userinput.app/d/did:plc:alice/first',
      author: { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatar: null },
      title: 'Add focus mode',
      body: 'Make the reading surface quieter.',
      tags: ['feature'],
      createdAt: '2026-09-01T12:00:00Z',
      votes: { up: 12, down: 2, net: 10 },
      replyCount: 2,
      status: 'planned',
    },
    {
      uri: 'at://did:plc:bob/app.userinput.discussion/second',
      url: 'https://userinput.app/d/did:plc:bob/second',
      author: { did: 'did:plc:bob', handle: 'bob.test', displayName: 'Bob', avatar: null },
      title: 'Fix feed refresh',
      body: 'Refresh can stall.',
      tags: ['bug'],
      createdAt: '2026-09-02T12:00:00Z',
      votes: { up: 5, down: 1, net: 4 },
      replyCount: 1,
      status: 'in-progress',
    },
    {
      uri: 'at://did:plc:carol/app.userinput.discussion/third',
      url: 'https://userinput.app/d/did:plc:carol/third',
      author: { did: 'did:plc:carol', handle: 'carol.test', displayName: null, avatar: null },
      title: 'Ship dark mode',
      body: 'Nights are bright.',
      tags: ['feature'],
      createdAt: '2026-09-03T12:00:00Z',
      votes: { up: 2, down: 1, net: 1 },
      replyCount: 0,
      // The one settled post: what gives the board its open/closed switch.
      status: 'implemented',
    },
  ],
};

/** Serve the board, and answer POSTs with what the backend returns on a write. */
async function stubBoard(page: Page, options: { canPost?: boolean } = {}) {
  await page.route('**/api/integrations/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        scopeStatus: { semble: false, margin: false, userinput: options.canPost === true },
      }),
    })
  );
  await page.route('**/api/v2/feedback', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          uri: 'at://did:plc:test/app.userinput.discussion/fresh',
          cid: 'bafyfresh',
          url: 'https://userinput.app/d/did:plc:test/fresh',
          createdAt: '2026-09-08T12:00:00Z',
          // The backend's self-upvote landed, so the optimistic row starts at one.
          upvoted: true,
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(board),
    });
  });
}

test.describe('Feedback', () => {
  test('opens from Settings, filters by status and reorders the list', async ({ authedPage }) => {
    await stubBoard(authedPage);
    await authedPage.goto('/settings');
    await authedPage.getByRole('main').getByRole('link', { name: 'Feedback' }).click();

    await expect(authedPage).toHaveURL(/\/feedback$/);
    await expect(authedPage.getByRole('heading', { name: 'Add focus mode' })).toBeVisible();
    await expect(authedPage.getByLabel('10 net votes')).toBeVisible();
    // Open by default: the settled post is out of the list until asked for.
    await expect(authedPage.getByRole('heading', { name: 'Ship dark mode' })).toBeHidden();

    // At this viewport the reading column has room for the chips; the
    // equivalent dropdowns below 560px are covered in the component test.
    const chips = authedPage.locator('.chip-controls');
    const status = chips.getByRole('group', { name: 'Filter by status' });
    await status.getByRole('button', { name: 'Closed' }).click();
    await expect(authedPage.getByRole('heading', { name: 'Ship dark mode' })).toBeVisible();
    await expect(authedPage.getByRole('heading', { name: 'Add focus mode' })).toBeHidden();

    await status.getByRole('button', { name: 'All' }).click();
    const titles = authedPage.locator('.posts .post h3');
    // Top by default: the most-wanted post leads, whatever its date.
    await expect(titles).toHaveText(['Add focus mode', 'Fix feed refresh', 'Ship dark mode']);

    await chips
      .getByRole('group', { name: 'Sort feedback' })
      .getByRole('button', { name: 'New' })
      .click();
    await expect(titles).toHaveText(['Ship dark mode', 'Fix feed refresh', 'Add focus mode']);
  });

  test('posts feedback without leaving Skyreader', async ({ authedPage }) => {
    await stubBoard(authedPage, { canPost: true });
    await authedPage.goto('/feedback');

    await authedPage.getByRole('button', { name: 'Post feedback' }).click();
    // Scoped to the composer: the type filter above the list is labelled "Type"
    // too, so an unscoped `getByLabel('Type')` would be ambiguous.
    const composer = authedPage.locator('form.composer');
    await composer.getByLabel('Title').fill('Sync highlights faster');
    await composer.getByLabel('Details').fill('They take a while to show up.');
    // The type track starts on Question; this post is a feature request.
    await expect(composer.getByRole('radio', { name: 'Question' })).toBeChecked();
    await composer.getByRole('radio', { name: 'Feature request' }).check();
    await composer.getByRole('button', { name: 'Post', exact: true }).click();

    await expect(authedPage.getByText(/Posted\./)).toBeVisible();
    // Shown straight away: upstream indexes by backlink, so a reload wouldn't
    // have it yet.
    await expect(authedPage.getByRole('heading', { name: 'Sync highlights faster' })).toBeVisible();
  });

  test('offers a re-login when the session predates the posting permission', async ({
    authedPage,
  }) => {
    await stubBoard(authedPage, { canPost: false });
    await authedPage.goto('/feedback');

    await expect(authedPage.getByRole('button', { name: 'Log in again' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Post feedback' })).toBeHidden();
    await expect(authedPage.getByRole('link', { name: 'post on userinput.app →' })).toBeVisible();
  });

  test('keeps a path to userinput.app when loading fails', async ({ authedPage }) => {
    await authedPage.route('**/api/v2/feedback', (route) =>
      route.fulfill({ status: 502, body: '{}' })
    );
    await authedPage.goto('/feedback');
    await expect(
      authedPage.getByRole('link', { name: 'Open it on userinput.app →' })
    ).toBeVisible();
  });
});
