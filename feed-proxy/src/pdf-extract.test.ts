import { describe, expect, it } from 'bun:test';
import { extractPdf, isPdf, parsePdfDate } from './pdf-extract';
import { makePdf, type Placed } from './pdf-fixture';

// Body text at 10pt on a 12pt leading, flowing down from `top`.
function para(top: number, lines: string[], x = 72): Placed[] {
  return lines.map((t, i) => [x, top - i * 12, 10, t]);
}

describe('isPdf', () => {
  it('trusts a PDF content type', () => {
    expect(isPdf(new Uint8Array(0), 'application/pdf; charset=binary')).toBe(true);
  });

  it('sniffs a PDF served as something else', () => {
    expect(isPdf(new TextEncoder().encode('%PDF-1.7\n...'), 'application/octet-stream')).toBe(true);
  });

  it('leaves HTML alone', () => {
    expect(
      isPdf(
        new TextEncoder().encode('<!doctype html><p>%PDF- is a header</p>'.slice(0, 20)),
        'text/html'
      )
    ).toBe(false);
  });
});

describe('parsePdfDate', () => {
  it('reads a UTC date', () => {
    expect(parsePdfDate('D:20240410211143Z')).toBe('2024-04-10T21:11:43.000Z');
  });

  it('applies an offset', () => {
    expect(parsePdfDate("D:20240410120000+02'00'")).toBe('2024-04-10T10:00:00.000Z');
  });

  it('rejects junk and implausible dates', () => {
    expect(parsePdfDate('yesterday')).toBeNull();
    expect(parsePdfDate('D:19700101000000Z')).toBeNull();
  });
});

// Distinct text per page: a line repeated on every page reads as a running header.
const threePages = (): Placed[][] =>
  ['First', 'Second', 'Third'].map((word) =>
    para(700, [`${word} page begins.`, 'A middle line.', `${word} page ends.`])
  );

describe('extractPdf', () => {
  it('reflows lines into paragraphs and headings, taking metadata from the Info dict', async () => {
    const pdf = makePdf(
      [
        [
          [72, 700, 20, 'A Study of Reading'],
          [72, 660, 13, 'Abstract'],
          ...para(640, [
            'We read many things and remember few of them. This paper',
            'asks why, and finds that annotation helps a great deal more',
            'than rereading does.',
          ]),
          [72, 580, 13, '1 Introduction'],
          ...para(560, ['Reading is an old habit. People have done it for a', 'long time.']),
          // A first-line indent starts the next paragraph with no extra space.
          ...para(536, [
            'A second paragraph begins here and goes on to say some',
            'more things.',
          ]).map(([x, y, s, t], i): Placed => [i === 0 ? x + 18 : x, y, s, t]),
          [300, 40, 10, '1'],
        ],
      ],
      { Author: 'Ada Reader', CreationDate: 'D:20240102030405Z' }
    );

    const out = await extractPdf(pdf);

    expect(out.title).toBe('A Study of Reading');
    expect(out.author).toBe('Ada Reader');
    expect(out.published).toBe('2024-01-02T03:04:05.000Z');
    expect(out.description).toStartWith('We read many things and remember few of them.');
    expect(out.pageCount).toBe(1);
    expect(out.content).toContain('<section data-pdf-page="1">');
    // The title is shown above the body, not repeated in it; the page number is dropped.
    expect(out.content).not.toContain('A Study of Reading');
    expect(out.content).not.toMatch(/<p>1<\/p>/);
    expect(out.content).toContain('<h3>1 Introduction</h3>');
    expect(out.content).toContain(
      '<p>We read many things and remember few of them. This paper asks why, and finds that annotation helps a great deal more than rereading does.</p>'
    );
    expect(out.content).toContain(
      '<p>Reading is an old habit. People have done it for a long time.</p>'
    );
    expect(out.content).toContain(
      '<p>A second paragraph begins here and goes on to say some more things.</p>'
    );
    expect(out.wordCount).toBeGreaterThan(40);
  });

  it('prefers a real metadata title and ignores a filename one', async () => {
    const page: Placed[] = [
      [72, 700, 20, 'Heading On The Page'],
      ...para(660, ['Body text, set smaller and running longer than the heading does.']),
    ];
    expect((await extractPdf(makePdf([page], { Title: 'The Real Title' }))).title).toBe(
      'The Real Title'
    );
    expect((await extractPdf(makePdf([page], { Title: 'draft-v3.docx' }))).title).toBe(
      'Heading On The Page'
    );
  });

  it('joins hyphenated line breaks and a paragraph split across pages', async () => {
    const out = await extractPdf(
      makePdf([
        para(700, ['The argument begins on this page and is inter-', 'rupted by the end of the']),
        para(700, ['page, then finishes here.']),
      ])
    );
    expect(out.content).toContain(
      'The argument begins on this page and is interrupted by the end of the page, then finishes here.'
    );
    // The continuation moved to page 1, leaving page 2 without a section.
    expect(out.content).not.toContain('data-pdf-page="2"');
  });

  it('drops a running header repeated on every page', async () => {
    const pages = [1, 2, 3, 4].map((n): Placed[] => [
      [72, 760, 8, `Journal of Reading, Vol. ${n}`],
      ...para(700, [
        `Page ${n} has its own sentence.`,
        'And a second line of body text,',
        'and a third.',
      ]),
    ]);
    const out = await extractPdf(makePdf(pages));
    expect(out.content).not.toContain('Journal of Reading');
    expect(out.content).toContain('Page 3 has its own sentence.');
  });

  it('escapes text that looks like markup', async () => {
    const out = await extractPdf(makePdf([para(700, ['if a < b && c > d then <script>'])]));
    expect(out.content).toContain('if a &lt; b &amp;&amp; c &gt; d then &lt;script&gt;');
    expect(out.content).not.toContain('<script>');
  });

  it('stops at the page cap and says so', async () => {
    const pages = threePages();
    const out = await extractPdf(makePdf(pages), { maxPages: 2 });
    expect(out.pagesKept).toBe(2);
    expect(out.pageCount).toBe(3);
    expect(out.content).not.toContain('Third page ends.');
    expect(out.content).toContain('first 2 of 3 pages');
  });

  it('stops at the size cap on a page boundary', async () => {
    const pages = threePages();
    const out = await extractPdf(makePdf(pages), { maxChars: 250 });
    expect(out.pagesKept).toBe(2);
    expect(out.content).toContain('Second page ends.');
    expect(out.content).not.toContain('Third page ends.');
    expect(out.content).toContain('first 2 of 3 pages');
  });

  it('stops when the time budget runs out, keeping what it read', async () => {
    let t = 0;
    const pages = threePages();
    // Each clock read advances 6s against a 10s budget: page 1 always, page 2 at
    // t=6, then out of time.
    const out = await extractPdf(makePdf(pages), { now: () => (t += 6000) - 6000 });
    expect(out.pagesKept).toBeLessThan(3);
    expect(out.content).toContain('First page ends.');
  });

  it('returns no content for a PDF with no text layer', async () => {
    const out = await extractPdf(makePdf([[]]));
    expect(out.content).toBeNull();
    expect(out.wordCount).toBe(0);
  });

  it('rejects bytes that are not a parseable PDF', async () => {
    await expect(extractPdf(new TextEncoder().encode('%PDF-1.4 nothing else'))).rejects.toThrow();
  });
});
