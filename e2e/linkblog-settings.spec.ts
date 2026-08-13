import { test, expect } from './fixtures';

// The publication picker on Settings is fed entirely by two endpoints that need a
// live PDS, so both are stubbed here. What's under test is the picker itself:
// that each publication arrives described (app, address, post count), that
// choosing one follows the format its app can actually read, and that
// publications Skyreader cannot publish to are explained without being selectable.
const CONNECTED_DID = 'did:plc:linkblog-picker';

const SKYREADER_URI = `at://${CONNECTED_DID}/site.standard.publication/skyreader-links`;
const LEAFLET_URI = `at://${CONNECTED_DID}/site.standard.publication/3ljmyleaflet`;
const PCKT_URI = `at://${CONNECTED_DID}/site.standard.publication/3ljmypckt`;
const UNKNOWN_URI = `at://${CONNECTED_DID}/site.standard.publication/3ljmyunknown`;

async function stubLinkblogApi(page: import('@playwright/test').Page) {
  await page.route('**/api/linkblog/publication', async (route) => {
    await route.fulfill({
      json: {
        uri: SKYREADER_URI,
        url: `https://linkblogs.skyreader.app/${CONNECTED_DID}/`,
        name: 'My links',
        exists: true,
        external: false,
        format: 'leaflet',
      },
    });
  });

  await page.route('**/api/linkblog/publications', async (route) => {
    await route.fulfill({
      json: {
        publications: [
          {
            uri: SKYREADER_URI,
            rkey: 'skyreader-links',
            name: 'My links',
            isDefault: true,
            appId: 'skyreader',
            appLabel: 'Skyreader',
            detectedFormat: 'leaflet',
            posts: 4,
          },
          {
            uri: LEAFLET_URI,
            rkey: '3ljmyleaflet',
            name: 'Field Notes',
            description: 'Occasional essays',
            url: 'https://leaflet.pub/lish/fieldnotes',
            isDefault: false,
            appId: 'leaflet',
            appLabel: 'Leaflet',
            detectedFormat: 'leaflet',
            formatLocked: true,
            posts: 12,
          },
          {
            uri: PCKT_URI,
            rkey: '3ljmypckt',
            name: 'Untitled publication',
            url: 'https://reader.pckt.blog/',
            isDefault: false,
            appId: 'pckt',
            appLabel: 'pckt',
            detectedFormat: 'pckt',
            formatLocked: true,
            supported: false,
            unsupportedReason: 'pckt does not currently import posts published by other apps.',
            posts: 1,
          },
          // An app Skyreader can't place: no label, and no format it can promise
          // renders there.
          {
            uri: UNKNOWN_URI,
            rkey: '3ljmyunknown',
            name: 'Field Journal',
            url: 'https://notes.example.com/',
            isDefault: false,
            posts: 2,
          },
        ],
      },
    });
  });
}

test.describe('Linkblog publication picker', () => {
  test('describes each publication and follows the app it belongs to', async ({ authedPage }) => {
    await stubLinkblogApi(authedPage);
    await authedPage.goto('/settings');

    const picker = authedPage.locator('.target-picker');
    await expect(picker).toBeVisible({ timeout: 10_000 });

    // The Skyreader linkblog reads as Skyreader's own, and as the live target.
    const skyreaderRow = picker.locator('.pub-option', { hasText: 'Your Skyreader linkblog' });
    await expect(skyreaderRow).toHaveClass(/selected/);
    await expect(skyreaderRow.locator('.pub-badge.is-live')).toHaveText('Publishing here');
    await expect(skyreaderRow.locator('.pub-meta')).toContainText('linkblogs.skyreader.app');
    await expect(skyreaderRow.locator('.pub-meta')).toContainText('4 posts');

    // An existing publication carries its app, its address and its size — enough
    // to tell two "Untitled publication" rows apart.
    const leafletRow = picker.locator('.pub-option', { hasText: 'Field Notes' });
    await expect(leafletRow.locator('.pub-badge.is-app')).toHaveText('Leaflet');
    await expect(leafletRow.locator('.pub-meta')).toContainText('leaflet.pub');
    await expect(leafletRow.locator('.pub-meta')).toContainText('12 posts');
    await expect(leafletRow.locator('.pub-desc')).toHaveText('Occasional essays');

    const pcktRow = picker.locator('.pub-option', { hasText: 'Untitled publication' });
    await expect(pcktRow.locator('.pub-badge.is-app')).toHaveText('pckt');
    await expect(pcktRow.locator('.pub-meta')).toContainText('reader.pckt.blog');

    // No format question while the Skyreader linkblog is the target, and nothing
    // to apply until something changes.
    await expect(picker.locator('#linkblog-format')).toHaveCount(0);
    await expect(picker.getByRole('button', { name: /Use my Skyreader linkblog/ })).toBeDisabled();

    // pckt does not import records written by other apps. Keep it visible so the
    // user understands why it cannot be chosen, but do not offer a publish action.
    await expect(pcktRow.locator('input[type="radio"]')).toBeDisabled();
    await expect(pcktRow.locator('.pub-badge.is-unavailable')).toHaveText("Can't publish here");
    await expect(pcktRow.locator('.pub-desc')).toHaveText(
      'pckt does not currently import posts published by other apps.'
    );
    // A real click on the row: the browser drops it because the label's control
    // is disabled, so the selection can't move. `force` skips Playwright's
    // actionability wait — it resolves a <label> to that control and would
    // otherwise wait forever for a disabled input to become enabled.
    await pcktRow.click({ force: true });
    await expect(skyreaderRow).toHaveClass(/selected/);
    await expect(pcktRow).not.toHaveClass(/selected/);
    await expect(picker.locator('#linkblog-format')).toHaveCount(0);
    await expect(picker.locator('.format-fixed')).toHaveCount(0);
    await expect(
      picker.getByRole('button', { name: /Publish to Untitled publication/ })
    ).toHaveCount(0);
    await expect(picker.getByRole('button', { name: /Use my Skyreader linkblog/ })).toBeDisabled();

    // Name and description stay editable while the Skyreader linkblog is live —
    // they're its fields, not a connected publication's.
    await expect(authedPage.locator('#linkblog-name')).toBeEnabled();

    // Choosing a publication Skyreader can publish to states the format its app
    // reads rather than asking, and offers the publish action by name.
    await leafletRow.click();
    await expect(leafletRow).toHaveClass(/selected/);
    await expect(picker.locator('#linkblog-format')).toHaveCount(0);
    await expect(picker.locator('.format-fixed')).toHaveText(
      'Links go in as Leaflet blocks, the only format Leaflet reads.'
    );
    await expect(picker.getByRole('button', { name: /Publish to Field Notes/ })).toBeEnabled();
  });

  test('opens the Skyreader linkblog from its row', async ({ authedPage }) => {
    await stubLinkblogApi(authedPage);
    await authedPage.goto('/settings');

    const picker = authedPage.locator('.target-picker');
    await expect(picker).toBeVisible({ timeout: 10_000 });

    const skyreaderRow = picker.locator('.pub-row', { hasText: 'Your Skyreader linkblog' });
    await expect(skyreaderRow.locator('.pub-open')).toHaveAttribute(
      'href',
      `https://linkblogs.skyreader.app/${CONNECTED_DID}/`
    );
  });

  test('says compatibility is unknown for a publication it can’t place', async ({ authedPage }) => {
    await stubLinkblogApi(authedPage);
    await authedPage.goto('/settings');

    const picker = authedPage.locator('.target-picker');
    await expect(picker).toBeVisible({ timeout: 10_000 });

    // Flagged on the row itself, before the user commits to it.
    const unknownRow = picker.locator('.pub-option', { hasText: 'Field Journal' });
    await expect(unknownRow.locator('.pub-badge.is-unknown')).toHaveText('Compatibility unknown');
    await expect(unknownRow.locator('.pub-badge.is-app')).toHaveCount(0);

    // A known app says nothing of the sort.
    const leafletRow = picker.locator('.pub-option', { hasText: 'Field Notes' });
    await expect(leafletRow.locator('.pub-badge.is-unknown')).toHaveCount(0);

    // Selecting it spells out the risk, and still offers the format choice and
    // the publish action — it's a caution, not a refusal.
    await unknownRow.click();
    await expect(unknownRow).toHaveClass(/selected/);
    await expect(picker.locator('.compat-warning')).toContainText(
      "Skyreader can't tell whether your links will show up here."
    );
    await expect(picker.locator('.compat-warning')).toContainText("isn't one Skyreader recognizes");
    await expect(picker.locator('#linkblog-format')).toBeVisible();
    await expect(picker.getByRole('button', { name: /Publish to Field Journal/ })).toBeEnabled();

    // Gone again once a publication Skyreader knows how to write for is picked.
    await leafletRow.click();
    await expect(picker.locator('.compat-warning')).toHaveCount(0);
  });
});
