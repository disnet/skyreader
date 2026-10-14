import { describe, expect, it } from 'vitest';
import { EpubError, looksLikeEpub, parseEpub } from '../src/services/epub';
import { buildEpub, buildZip } from './helpers/epub';

describe('parseEpub', () => {
  it('reads metadata and joins the spine into chapter sections', async () => {
    const epub = await buildEpub({
      title: 'Nineteen &amp; Eighty-Four',
      creators: ['George Orwell'],
      date: '1949',
      description: '<p>A <b>dystopian</b> novel.</p>',
      chapters: [
        { id: 'ch1', body: '<h1>One</h1><p>It was a bright cold day in April.</p>' },
        { id: 'ch2', body: '<h1>Two</h1><p>Winston was dreaming of his mother.</p>' },
      ],
    });
    expect(looksLikeEpub(epub)).toBe(true);
    const book = await parseEpub(epub);
    expect(book.title).toBe('Nineteen & Eighty-Four');
    expect(book.author).toBe('George Orwell');
    expect(book.description).toBe('A dystopian novel.');
    expect(book.published).toBe('1949-01-01T00:00:00.000Z');
    expect(book.chapterCount).toBe(2);
    expect(book.chaptersKept).toBe(2);
    expect(book.content).toContain('<section data-epub-chapter="1">');
    expect(book.content).toContain('<section data-epub-chapter="2">');
    expect(book.content!.indexOf('bright cold day')).toBeLessThan(
      book.content!.indexOf('dreaming of his mother')
    );
    expect(book.wordCount).toBe(1 + 8 + 1 + 6);
  });

  it('strips styles, scripts, images, ids and internal links, keeping text', async () => {
    const book = await parseEpub(
      await buildEpub({
        chapters: [
          {
            id: 'ch1',
            body: `<style>p{color:red}</style><script>alert(1)</script>
<p class="first" id="p1" style="x" onclick="evil()">Hello <span class="sc">world</span><a id="anchor"/> again.</p>
<p>See <a href="ch2.xhtml#n1" epub:type="noteref">note 1</a> and <a href="https://example.com/">the site</a>.</p>
<span epub:type="pagebreak" id="page12" title="12">12</span>
<figure><img src="../images/fig.png" alt="A figure"/><figcaption>Figure 1</figcaption></figure>`,
          },
        ],
      })
    );
    const html = book.content!;
    expect(html).not.toMatch(/<style|<script|<img|class=|id=|style=|onclick|alert/);
    expect(html).toContain('<p>Hello world again.</p>');
    expect(html).toContain('See note 1 and <a href="https://example.com/">the site</a>.');
    expect(html).not.toContain('>12<');
    expect(html).toContain('Figure 1');
  });

  it('skips non-linear items, the nav document and image-only chapters', async () => {
    const book = await parseEpub(
      await buildEpub({
        chapters: [
          { id: 'cover', body: '<img src="cover.jpg" alt=""/>' },
          {
            id: 'toc',
            body: '<nav><ol><li><a href="ch1.xhtml">One</a></li></ol></nav>',
            nav: true,
          },
          { id: 'ch1', body: '<p>The text.</p>' },
          { id: 'answers', body: '<p>Answer key.</p>', linear: false },
        ],
      })
    );
    expect(book.chapterCount).toBe(1);
    expect(book.content).toContain('The text.');
    expect(book.content).not.toContain('Answer key');
    expect(book.content).not.toContain('One');
  });

  it('keeps whole chapters under the size cap and says when it stops early', async () => {
    const para = `<p>${'word '.repeat(200)}</p>`;
    const chapters = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, body: para.repeat(5) }));
    const book = await parseEpub(await buildEpub({ chapters }), { maxContentBytes: 16_000 });
    expect(book.chapterCount).toBe(10);
    expect(book.chaptersKept).toBeGreaterThan(0);
    expect(book.chaptersKept).toBeLessThan(10);
    expect(book.content).toContain(`the first ${book.chaptersKept} of 10 chapters`);
  });

  it('cuts a first chapter that is over the cap alone at a block boundary', async () => {
    const body = Array.from(
      { length: 50 },
      (_, i) => `<p>Paragraph ${i} ${'x '.repeat(50)}</p>`
    ).join('');
    const book = await parseEpub(await buildEpub({ chapters: [{ id: 'c', body }] }), {
      maxContentBytes: 2_000,
    });
    expect(book.content).toContain('Paragraph 0');
    expect(book.content).not.toContain('Paragraph 49');
    expect(book.content).toContain('part of chapter 1 of 1');
    expect(new TextEncoder().encode(book.content!).length).toBeLessThan(2_400);
  });

  it('turns XHTML self-closing tags into closed elements', async () => {
    const book = await parseEpub(
      await buildEpub({
        chapters: [{ id: 'c', body: '<p>One<br/>two</p><div/><p>Three</p>' }],
      })
    );
    expect(book.content).toMatch(/<p>One<br\/?>two<\/p>/);
    expect(book.content).toContain('<p>Three</p>');
  });

  it('reads stored (uncompressed) entries too', async () => {
    const zip = await buildZip(
      [
        ['mimetype', 'application/epub+zip'],
        [
          'META-INF/container.xml',
          '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
        ],
        [
          'book.opf',
          '<package><metadata><dc:title>Stored</dc:title></metadata><manifest><item id="a" href="a%20b.html" media-type="text/html"/></manifest><spine><itemref idref="a"/></spine></package>',
        ],
        ['a b.html', '<html><body><p>Plain stored text.</p></body></html>'],
      ],
      { stored: ['META-INF/container.xml', 'book.opf', 'a b.html'] }
    );
    const book = await parseEpub(zip);
    expect(book.title).toBe('Stored');
    expect(book.content).toContain('Plain stored text.');
  });

  it('refuses a file that is not an EPUB', async () => {
    await expect(parseEpub(new TextEncoder().encode('%PDF-1.7'))).rejects.toBeInstanceOf(EpubError);
    const zip = await buildZip([['hello.txt', 'hi']]);
    expect(looksLikeEpub(zip)).toBe(false);
    await expect(parseEpub(zip)).rejects.toThrow("This file isn't an EPUB.");
  });

  it('refuses a DRM-protected book, but not font obfuscation', async () => {
    const encryption = (uri: string) =>
      `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;
    const drm = await buildEpub({
      extra: [['META-INF/encryption.xml', encryption('OEBPS/text/ch1.xhtml')]],
    });
    await expect(parseEpub(drm)).rejects.toThrow(/DRM/);

    const fonts = await buildEpub({
      extra: [['META-INF/encryption.xml', encryption('OEBPS/fonts/serif.otf')]],
    });
    expect((await parseEpub(fonts)).content).toContain('bright cold day');
  });

  it('answers no content for a book with no text', async () => {
    const book = await parseEpub(
      await buildEpub({ chapters: [{ id: 'c', body: '<img src="page1.jpg"/>' }] })
    );
    expect(book.content).toBeNull();
    expect(book.wordCount).toBe(0);
  });
});
