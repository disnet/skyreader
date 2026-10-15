import { test, expect } from './fixtures';
import { makeSupporter, seedSavedArticle } from './seed';

// A saved EPUB reads as its text, with its pictures and its own links working:
// a picture is a reference into the kept book (`data-epub-src`) that the reader
// points at GET /api/saved/<rkey>/asset (stubbed here: a real one needs an
// upload into R2), and a footnote marker jumps to its note in place.

const TITLE = 'A Book With Notes';
// One transparent pixel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);
const filler = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `<p>Filler paragraph ${i + 1}, there to push the notes down the page.</p>`
  ).join('');
const BODY = [
  '<section data-epub-chapter="1" id="epub-c1">',
  '<h1>Chapter One</h1>',
  '<p>A claim that needs a source.<a id="epub-c1-r1" href="#epub-c2-n1">1</a> And <a href="https://example.com/">a link out</a>.</p>',
  '<figure><img data-epub-src="OEBPS/images/plate 1.png" alt="Plate one"><figcaption>Plate one</figcaption></figure>',
  filler(60),
  '</section>',
  '<section data-epub-chapter="2" id="epub-c2">',
  '<h1>Notes</h1>',
  '<aside id="epub-c2-n1"><p>The source, at last.</p></aside>',
  '</section>',
].join('\n');

test.describe('EPUB reader', () => {
  test('shows the book’s pictures and follows its own links in place', async ({
    authedPage,
    testUser,
  }) => {
    await makeSupporter(testUser);
    const rkey = await seedSavedArticle(testUser, {
      url: '',
      title: TITLE,
      source: 'upload',
      contentType: 'epub',
      content: BODY,
      wordCount: 700,
    });
    const assetPaths: string[] = [];
    await authedPage.route(`**/api/saved/${rkey}/asset?**`, (route) => {
      assetPaths.push(new URL(route.request().url()).searchParams.get('path') ?? '');
      return route.fulfill({ body: PNG, contentType: 'image/png' });
    });

    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
    const reader = authedPage.locator('.reader-body');
    await expect(reader.getByText('A claim that needs a source.')).toBeVisible({ timeout: 15_000 });

    const plate = reader.getByRole('img', { name: 'Plate one' });
    await expect(plate).toHaveAttribute(
      'src',
      /\/api\/saved\/.+\/asset\?path=OEBPS%2Fimages%2Fplate%201\.png$/
    );
    await plate.scrollIntoViewIfNeeded();
    await expect
      .poll(() => plate.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    expect(assetPaths).toContain('OEBPS/images/plate 1.png');

    // The footnote marker jumps to its note, in this tab.
    const note = reader.getByText('The source, at last.');
    await expect(note).not.toBeInViewport();
    const pages = authedPage.context().pages().length;
    await reader.getByRole('link', { name: '1', exact: true }).click();
    await expect(note).toBeInViewport({ timeout: 5_000 });
    expect(authedPage.context().pages().length).toBe(pages);
  });
});
