import { test as base, type Page } from '@playwright/test';
import { seedTestUser, cleanupTestData, type TestUser } from './seed';

interface TestFixtures {
  testUser: TestUser;
  authedPage: Page;
}

export const test = base.extend<TestFixtures>({
  testUser: async ({}, use) => {
    const user = await seedTestUser();
    await use(user);
    await cleanupTestData(user);
  },

  authedPage: async ({ context, testUser }, use) => {
    // Set the session cookie so the backend recognizes us
    await context.addCookies([
      {
        name: 'session_id',
        value: testUser.sessionId,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    const page = await context.newPage();

    // Navigate to a page so we can set localStorage
    await page.goto('/');

    // Set the auth localStorage so the frontend renders the main app (not WelcomePage)
    await page.evaluate(
      ({ handle, did }) => {
        localStorage.setItem(
          'skyreader-auth',
          JSON.stringify({
            user: {
              did,
              handle,
              displayName: 'Test User',
            },
          })
        );
      },
      { handle: testUser.handle, did: testUser.did }
    );

    // Reload to pick up the localStorage auth state
    await page.reload();

    await use(page);
  },
});

export { expect } from '@playwright/test';
