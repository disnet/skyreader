import { describe, expect, it } from 'vitest';
import { extractPdf, parsePdfDate } from './extract';
import { makePdf, type Placed } from './pdf-fixture';

// Body text at 10pt on a 12pt leading, flowing down from `top`.
function para(top: number, lines: string[], x = 72): Placed[] {
  return lines.map((t, i) => [x, top - i * 12, 10, t]);
}

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
    expect(out.description?.startsWith('We read many things and remember few of them.')).toBe(true);
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

  it('folds a paragraph across a page left empty by an earlier fold', async () => {
    const out = await extractPdf(
      makePdf([
        para(700, ['The sentence starts on the first page and']),
        para(700, ['carries on over the whole second page and']),
        para(700, ['only ends on the third.']),
      ])
    );
    expect(out.content).toContain(
      '<p>The sentence starts on the first page and carries on over the whole second page and only ends on the third.</p>'
    );
  });

  it('keeps a closing word made of roman-numeral letters, drops a roman page number', async () => {
    const pages = [
      ['Alpha', 'civil'],
      ['Beta', 'I'],
      ['Gamma', 'iv'],
    ].map(([opening, last]): Placed[] => [
      ...para(700, [`${opening} opens this page, and`, 'the last word is']),
      [72, 676, 10, last],
    ]);
    const out = await extractPdf(makePdf(pages));
    expect(out.content).toContain('the last word is civil');
    expect(out.content).toContain('the last word is I');
    expect(out.content).not.toContain('the last word is iv');
  });

  it('ends a body-size numbered subsection at a heading-sized gap', async () => {
    const out = await extractPdf(
      makePdf([
        [
          ...para(700, ['Some opening text that sets the body size for the page.']),
          [72, 670, 10, '3.1 Encoder Stacks'],
          // 1.5 lines below the heading: under a paragraph gap, over a heading's.
          ...para(652, ['The encoder is a stack of identical layers, each with two', 'parts.']),
        ],
      ])
    );
    expect(out.content).toContain('<h4>3.1 Encoder Stacks</h4>');
    expect(out.content).toContain('<p>The encoder is a stack');
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
    const out = await extractPdf(makePdf(pages), { maxBytes: 250 });
    expect(out.pagesKept).toBe(2);
    expect(out.content).toContain('Second page ends.');
    expect(out.content).not.toContain('Third page ends.');
    expect(out.content).toContain('first 2 of 3 pages');
  });

  it('measures the size cap in UTF-8 bytes, not characters', async () => {
    // Each "€" reads back as a non-ASCII character, three bytes in UTF-8.
    const accented = (word: string) =>
      para(700, [`${word} begins.`, ...Array(4).fill('€'.repeat(30)), `${word} ends.`]);
    const one = await extractPdf(makePdf([accented('First')]));
    const section = one.content!;
    const chars = section.length;
    const bytes = new TextEncoder().encode(section).length;
    expect(bytes).toBeGreaterThan(chars * 1.5);
    // Room for two pages by character count, but only one by bytes.
    const out = await extractPdf(makePdf([accented('First'), accented('Second')]), {
      maxBytes: Math.floor(chars * 2.2),
    });
    expect(out.pagesKept).toBe(1);
    expect(out.content).toContain('first 1 of 2 pages');
  });

  it('cuts a first page that is over the size cap on its own', async () => {
    const out = await extractPdf(
      makePdf([
        [
          ...para(700, ['An opening paragraph that fits.']),
          ...para(600, ['A second paragraph that does not fit in what is left.']),
        ],
        para(700, ['Second page.']),
      ]),
      { maxBytes: 120 }
    );
    expect(new TextEncoder().encode(out.content!.split('\n<p><em>')[0]).length).toBeLessThanOrEqual(
      120
    );
    expect(out.content).toContain('An opening paragraph that fits.');
    expect(out.content).not.toContain('Second page.');
    expect(out.content).toContain('part of page 1 of 2');
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

// A raw single-page PDF, for text matrices makePdf can't express (it only Td's).
function rawPdf(stream: string): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('rotated and slanted text', () => {
  it('keeps a synthetic italic (a slanted, not rotated, matrix)', async () => {
    const out = await extractPdf(
      rawPdf(
        [
          'BT /F1 10 Tf 1 0 0 1 72 700 Tm (The quick brown fox) Tj ET',
          'BT /F1 10 Tf 1 0 0.2 1 170 700 Tm (jumped) Tj ET',
          'BT /F1 10 Tf 1 0 0 1 206 700 Tm (over the lazy dog.) Tj ET',
        ].join('\n')
      )
    );
    expect(out.content).toContain('fox jumped over');
  });

  it('drops text rotated off the baseline', async () => {
    const out = await extractPdf(
      rawPdf(
        [
          'BT /F1 10 Tf 1 0 0 1 72 700 Tm (Body text stays in the reader.) Tj ET',
          'BT /F1 10 Tf 0 1 -1 0 20 400 Tm (arXiv:1706.03762v7) Tj ET',
        ].join('\n')
      )
    );
    expect(out.content).toContain('Body text stays');
    expect(out.content).not.toContain('arXiv');
  });
});

describe('fallback title', () => {
  it('never takes a paragraph set in large type', async () => {
    const blurb = 'An opening paragraph set large on the cover, much longer than any title. ';
    const body: Placed[] = Array.from({ length: 30 }, (_, i) => [
      72,
      560 - i * 12,
      10,
      'Body text that sets the size most of this document is written in, line after line.',
    ]);
    const out = await extractPdf(
      makePdf([
        [
          ...[0, 1, 2, 3, 4].map((i): Placed => [72, 740 - i * 16, 14, blurb]),
          [72, 640, 13, 'The Real Title'],
          ...body,
        ],
      ])
    );
    expect(out.title).toBe('The Real Title');
  });
});

describe('extractPdf: outline', () => {
  const pages = (): Placed[][] => [
    [
      [72, 700, 16, 'Getting Started'],
      ...para(670, ['The first page has some text on it.', 'And a second line here.']),
      ...para(560, ['Further down the first page, more text.', 'It goes on.']),
    ],
    [...para(700, ['Second page text, all body type.', 'More of it here.'])],
    [],
    [...para(700, ['Fourth page, after a blank one.', 'The end of it.'])],
  ];

  it('marks each outline entry on the block it points at', async () => {
    const out = await extractPdf(
      makePdf(pages(), { Title: 'A Manual' }, [
        {
          title: 'Getting  Started',
          page: 0,
          top: 720,
          children: [{ title: 'Lower down', page: 0, top: 575 }],
        },
        { title: 'Page two', page: 1 },
        { title: 'Blank page', page: 2 },
      ])
    );
    const html = out.content!;
    expect(html).toContain(
      '<h2 data-toc-title="Getting Started" data-toc-level="1">Getting Started</h2>'
    );
    expect(html).toContain(
      '<p data-toc-title="Lower down" data-toc-level="2">Further down the first page, more text. It goes on.</p>'
    );
    expect(html).toContain('<p data-toc-title="Page two" data-toc-level="1">Second page text');
    // A page with no text hands its entry to the next block.
    expect(html).toContain('<p data-toc-title="Blank page" data-toc-level="1">Fourth page');
  });

  it('keeps every entry when several land on one block, in outline order', async () => {
    const out = await extractPdf(
      makePdf(pages(), { Title: 'A Manual' }, [
        { title: 'Part <One>', page: 1 },
        { title: 'Chapter "1"', page: 1, children: [{ title: 'Deep', page: 1 }] },
      ])
    );
    expect(out.content).toContain(
      [
        '<div data-toc-title="Part &lt;One&gt;" data-toc-level="1"></div>',
        '<div data-toc-title="Chapter &quot;1&quot;" data-toc-level="1"></div>',
        '<p data-toc-title="Deep" data-toc-level="2">Second page text',
      ].join('\n')
    );
  });

  it('leaves a PDF without an outline unmarked', async () => {
    const out = await extractPdf(makePdf(pages(), { Title: 'A Manual' }));
    expect(out.content).not.toContain('data-toc');
  });
});
