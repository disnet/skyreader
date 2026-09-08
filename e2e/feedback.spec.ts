import { expect, test } from './fixtures';

const board = {
  spaceUrl: 'https://userinput.app/s/did:plc:space/space-rkey',
  total: 2,
  complete: true,
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
  ],
};

test.describe('Feedback', () => {
  test('opens from Settings and filters the native board', async ({ authedPage }) => {
    await authedPage.route('**/api/v2/feedback', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(board) })
    );
    await authedPage.goto('/settings');
    await authedPage.getByRole('main').getByRole('link', { name: 'Feedback' }).click();

    await expect(authedPage).toHaveURL(/\/feedback$/);
    await expect(authedPage.getByRole('heading', { name: 'Add focus mode' })).toBeVisible();
    await expect(authedPage.getByLabel('10 net votes')).toBeVisible();

    await authedPage.getByRole('button', { name: 'Bugs' }).click();
    await expect(authedPage.getByRole('heading', { name: 'Fix feed refresh' })).toBeVisible();
    await expect(authedPage.getByRole('heading', { name: 'Add focus mode' })).toBeHidden();
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
