import { test, expect } from './fixtures';
import { seedSavedArticle, seedShelfCollection } from './seed';

// Each Shelf collection gets its own lane on Home, in the collection's order,
// linking to the collection; an empty one shows no lane but can still be placed
// from Customize.
test.describe('Home collection lanes', () => {
  test('a collection with items is a lane on Home; an empty one is only in Customize', async ({
    authedPage,
    testUser,
  }) => {
    const first = await seedSavedArticle(testUser, {
      url: 'https://example.com/collected-first',
      title: 'First In The Collection',
      domain: 'example.com',
      content: '<p>One.</p>',
      savedAt: Date.now() - 120_000,
    });
    const second = await seedSavedArticle(testUser, {
      url: 'https://example.com/collected-second',
      title: 'Second In The Collection',
      domain: 'example.com',
      content: '<p>Two.</p>',
      savedAt: Date.now() - 60_000,
    });
    await seedShelfCollection(testUser, {
      id: '3homecoll0001',
      name: 'Thesis sources',
      position: 0,
      items: [first, second],
    });
    await seedShelfCollection(testUser, {
      id: '3homecoll0002',
      name: 'Nothing here yet',
      position: 1,
    });

    await authedPage.goto('/home');
    const lane = authedPage.getByRole('region', { name: 'Thesis sources' });
    await expect(lane).toBeVisible({ timeout: 15_000 });
    // The collection's own order, not newest-saved first.
    await expect(lane.getByText('First In The Collection')).toBeVisible();
    await expect(lane.getByText('Second In The Collection')).toBeVisible();
    const text = await lane.innerText();
    expect(text.indexOf('First In The Collection')).toBeLessThan(
      text.indexOf('Second In The Collection')
    );
    await expect(lane.getByRole('link', { name: 'Open collection' })).toHaveAttribute(
      'href',
      '/shelf?collection=3homecoll0001'
    );

    // The empty collection has no lane, but Customize lists it to place.
    await expect(authedPage.getByRole('region', { name: 'Nothing here yet' })).toHaveCount(0);
    await authedPage.getByRole('button', { name: 'Customize' }).first().click();
    await expect(
      authedPage.getByRole('button', { name: 'Reorder Nothing here yet' })
    ).toBeVisible();

    // Hiding the lane in Customize takes it off Home.
    await authedPage.getByRole('checkbox', { name: /Thesis sources/ }).uncheck();
    await authedPage.keyboard.press('Escape');
    await expect(authedPage.getByRole('region', { name: 'Thesis sources' })).toHaveCount(0);
  });
});
