import { describe, expect, it } from 'vitest';
import { EpubError, looksLikeEpub, parseEpub } from '../src/services/epub';
import { buildEpub, buildZip } from './helpers/epub';

describe('parseEpub', () => {
  // A kept book is parsed a range at a time: the same book, never held whole.
  it('reads a book by range as it reads one in memory', async () => {
    const epub = await buildEpub({
      title: 'Ranged',
      chapters: Array.from({ length: 9 }, (_, i) => ({
        id: `ch${i + 1}`,
        body: `<h1>Chapter ${i + 1}</h1><p>${'Words that fill a chapter. '.repeat(40)}</p>`,
      })),
      // A picture, so the book is bigger than the tail read that finds its file list.
      extra: [['OEBPS/plate.bin', new Uint8Array(300_000).fill(7)]],
      stored: ['OEBPS/plate.bin'],
    });
    const reads: number[] = [];
    const ranged = {
      size: async () => epub.byteLength,
      read: async (offset: number, length: number) => {
        reads.push(length);
        return epub.slice(offset, offset + length);
      },
    };
    const whole = await parseEpub(epub);
    expect(await parseEpub(ranged)).toEqual(whole);
    // Never the whole book, and never the picture it doesn't read.
    expect(Math.max(...reads)).toBeLessThan(100_000);
  });

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
    expect(book.content).toContain('<section data-epub-chapter="1" id="epub-c1">');
    expect(book.content).toContain('<section data-epub-chapter="2" id="epub-c2">');
    expect(book.content!.indexOf('bright cold day')).toBeLessThan(
      book.content!.indexOf('dreaming of his mother')
    );
    expect(book.wordCount).toBe(1 + 8 + 1 + 6);
  });

  it('strips styles, scripts and attributes, keeping text', async () => {
    const book = await parseEpub(
      await buildEpub({
        chapters: [
          {
            id: 'ch1',
            body: `<style>p{color:red}</style><script>alert(1)</script>
<p class="first" style="x" onclick="evil()">Hello <span class="sc">world</span> again.</p>
<p>See <a href="https://example.com/">the site</a> and <a href="javascript:evil()">this</a>.</p>
<span epub:type="pagebreak" id="page12" title="12">12</span>`,
          },
        ],
      })
    );
    const html = book.content!;
    expect(html).not.toMatch(/<style|<script|class=|style=|onclick|alert|evil/);
    expect(html).toContain('<p>Hello world again.</p>');
    expect(html).toContain('See <a href="https://example.com/">the site</a> and this.');
    expect(html).not.toContain('>12<');
  });

  it('scopes ids by chapter and points the book’s own links at them', async () => {
    const book = await parseEpub(
      await buildEpub({
        chapters: [
          {
            id: 'ch1',
            body: `<p id="intro">Start.<a id="r1" href="ch2.xhtml#n%201">1</a> <a href="#intro">Back up</a> <a href="ch2.xhtml">Next</a> <a href="notes.xhtml#x">Gone</a></p>`,
          },
          {
            id: 'ch2',
            body: '<aside id="n 1"><p>The note.</p></aside><a name="old">Old anchor</a>',
          },
        ],
      })
    );
    const html = book.content!;
    expect(html).toContain('<p id="epub-c1-intro">');
    expect(html).toContain('<a id="epub-c1-r1" href="#epub-c2-n_1">1</a>');
    expect(html).toContain('<a href="#epub-c1-intro">Back up</a>');
    expect(html).toContain('<a href="#epub-c2">Next</a>');
    // A link outside the reading order is just its text.
    expect(html).toContain(' Gone</p>');
    expect(html).toContain('<aside id="epub-c2-n_1">');
    expect(html).toContain('<a id="epub-c2-old">Old anchor</a>');
  });

  it('keeps pictures as references into the book', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const book = await parseEpub(
      await buildEpub({
        chapters: [
          {
            id: 'cover',
            body: '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image width="600" xlink:href="../images/cover.jpg"/></svg>',
          },
          {
            id: 'ch1',
            body: `<p>Text.</p><figure><img src="../images/fig%201.png" alt="A figure" class="big"/><figcaption>Figure 1</figcaption></figure>
<img src="../images/missing.png" alt="gone"/><img src="data:image/png;base64,AAAA"/><img src="../styles/a.css"/>`,
          },
        ],
        extra: [
          ['OEBPS/images/cover.jpg', png],
          ['OEBPS/images/fig 1.png', png],
          ['OEBPS/styles/a.css', 'p{}'],
        ],
      })
    );
    const html = book.content!;
    // The cover is only a picture, and is kept as the book's first section.
    expect(html).toMatch(
      /<section data-epub-chapter="1" id="epub-c1">\n<img data-epub-src="OEBPS\/images\/cover.jpg" alt="">/
    );
    expect(html).toMatch(/<img data-epub-src="OEBPS\/images\/fig 1.png" alt="A figure"\s*\/?>/);
    expect(html).toContain('Figure 1');
    expect(html).not.toMatch(/missing|data:image|a\.css|class=|\ssrc=/);
  });

  describe('the cover', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const coverSection =
      '<section data-epub-cover="" id="epub-cover">\n<p><img data-epub-src="OEBPS/images/front.png" alt="Cover"></p>\n</section>';

    it('puts an EPUB 3 cover-image the spine leaves out first', async () => {
      const book = await parseEpub(
        await buildEpub({
          chapters: [{ id: 'ch1', body: '<p>The text.</p>' }],
          manifest: [
            '<item id="img" href="images/front.png" media-type="image/png" properties="cover-image"/>',
          ],
          extra: [['OEBPS/images/front.png', png]],
        })
      );
      expect(book.coverPath).toBe('OEBPS/images/front.png');
      expect(book.content!.startsWith(coverSection)).toBe(true);
      expect(book.chaptersKept).toBe(1);
      expect(book.wordCount).toBe(2);
    });

    it('reads an EPUB 2 cover from <meta name="cover">, past a non-linear cover page', async () => {
      const book = await parseEpub(
        await buildEpub({
          chapters: [
            { id: 'titlepage', body: '<img src="../images/front.png" alt=""/>', linear: false },
            { id: 'ch1', body: '<p>The text.</p>' },
          ],
          metadata: '<meta name="cover" content="front-img"/>',
          manifest: ['<item id="front-img" href="images/front.png" media-type="image/png"/>'],
          extra: [['OEBPS/images/front.png', png]],
        })
      );
      expect(book.coverPath).toBe('OEBPS/images/front.png');
      expect(book.content!.startsWith(coverSection)).toBe(true);
    });

    it('is not repeated when a chapter already shows it', async () => {
      const book = await parseEpub(
        await buildEpub({
          chapters: [
            { id: 'cover', body: '<img src="../images/front.png" alt=""/>' },
            { id: 'ch1', body: '<p>The text.</p>' },
          ],
          manifest: [
            '<item id="img" href="images/front.png" media-type="image/png" properties="cover-image"/>',
          ],
          extra: [['OEBPS/images/front.png', png]],
        })
      );
      expect(book.content).not.toContain('data-epub-cover');
      expect(book.content!.match(/front\.png/g)).toHaveLength(1);
      expect(book.content!.startsWith('<section data-epub-chapter="1"')).toBe(true);
    });

    it('is left out when the book names a picture it doesn’t hold', async () => {
      const book = await parseEpub(
        await buildEpub({
          chapters: [{ id: 'ch1', body: '<p>The text.</p>' }],
          manifest: [
            '<item id="img" href="images/front.png" media-type="image/png" properties="cover-image"/>',
          ],
        })
      );
      expect(book.coverPath).toBeNull();
      expect(book.content).not.toContain('data-epub-cover');
    });
  });

  it('skips non-linear items, the nav document and chapters with nothing kept', async () => {
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
    // Its entry marks the chapter for the contents list, but isn't text.
    expect(book.content).not.toMatch(/>\s*One\s*</);
  });

  it('marks the book’s nav TOC on the elements its entries land on', async () => {
    const book = await parseEpub(
      await buildEpub({
        chapters: [
          {
            id: 'toc',
            body: `<nav epub:type="landmarks"><ol><li><a href="ch2.xhtml">Start</a></li></ol></nav>
<nav epub:type="toc"><h1>Contents</h1><ol>
  <li><a href="ch1.xhtml"><span>Part &amp; One</span></a>
    <ol>
      <li><a href="ch2.xhtml#s1">A "quoted" section</a></li>
      <li><a href="ch2.xhtml#gone">Missing target</a></li>
    </ol>
  </li>
  <li><a href="https://example.com/">Elsewhere</a></li>
  <li><a href="ch3.xhtml#late">Later</a></li>
</ol></nav>`,
            nav: true,
          },
          { id: 'ch1', body: '<h1>Part One</h1><p>Opening words here.</p>' },
          { id: 'ch2', body: '<p>Before.</p><h2 id="s1">Section</h2><p>After.</p>' },
          { id: 'ch3', body: '<p>Some text.</p><p id="late">Late text.</p>' },
        ],
      })
    );
    const html = book.content!;
    expect(html).toContain(
      '<section data-epub-chapter="1" id="epub-c1" data-toc-title="Part &amp; One" data-toc-level="1">'
    );
    expect(html).toMatch(
      /<h2 id="epub-c2-s1" data-toc-title="A (&quot;|")quoted(&quot;|") section" data-toc-level="2">Section<\/h2>/
    );
    // A target the cleanup didn't keep falls back to its chapter.
    expect(html).toContain(
      '<section data-epub-chapter="2" id="epub-c2" data-toc-title="Missing target" data-toc-level="2">'
    );
    expect(html).toContain('<p id="epub-c3-late" data-toc-title="Later" data-toc-level="1">');
    expect(html).not.toContain('Elsewhere');
    expect(html).not.toContain('Start');
  });

  it('marks an EPUB 2 NCX TOC', async () => {
    const book = await parseEpub(
      await buildEpub({
        ncx: `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head></head><docTitle><text>The Book</text></docTitle>
  <navMap>
    <navPoint id="p1" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="text/ch1.xhtml"/>
      <navPoint id="p2" playOrder="2">
        <navLabel><text>First Part</text></navLabel>
        <content src="text/ch1.xhtml#part1"/>
      </navPoint>
    </navPoint>
    <navPoint id="p3" playOrder="3">
      <navLabel><text>Chapter Two</text></navLabel>
      <content src="text/ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
        chapters: [
          { id: 'ch1', body: '<p>Intro.</p><h2 id="part1">Part</h2><p>Body.</p>' },
          { id: 'ch2', body: '<p>Second chapter.</p>' },
        ],
      })
    );
    const html = book.content!;
    expect(html).toContain('id="epub-c1" data-toc-title="Chapter One" data-toc-level="1">');
    expect(html).toContain(
      '<h2 id="epub-c1-part1" data-toc-title="First Part" data-toc-level="2">'
    );
    expect(html).toContain('id="epub-c2" data-toc-title="Chapter Two" data-toc-level="1">');
    expect(html).not.toContain('The Book');
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

  it('cuts a big chapter after a cover rather than keeping only the cover', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const body = Array.from(
      { length: 50 },
      (_, i) => `<p>Paragraph ${i} ${'x '.repeat(50)}</p>`
    ).join('');
    const book = await parseEpub(
      await buildEpub({
        chapters: [
          { id: 'cover', body: '<img src="../images/cover.png" alt=""/>' },
          { id: 'book', body },
        ],
        extra: [['OEBPS/images/cover.png', png]],
      }),
      { maxContentBytes: 2_000 }
    );
    expect(book.content).toContain('data-epub-src="OEBPS/images/cover.png"');
    expect(book.content).toContain('Paragraph 0');
    expect(book.content).not.toContain('Paragraph 49');
    expect(book.wordCount).toBeGreaterThan(0);
    expect(book.chaptersKept).toBe(2);
    expect(book.content).toContain('part of chapter 2 of 2');
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
