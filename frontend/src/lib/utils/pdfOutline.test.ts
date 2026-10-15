import { describe, expect, it } from 'vitest';
import { flattenPdfOutline } from './pdfOutline';
import type { PdfLinkDoc } from './pdfLinks';

const ref = (num: number) => ({ num, gen: 0 });

// Page objects are refs whose number is 100 + the page index.
const doc: PdfLinkDoc = {
  numPages: 10,
  getDestination: async (name) => (name === 'ch2' ? [ref(104), { name: 'Fit' }] : null),
  getPageIndex: async (r) => r.num - 100,
};

describe('flattenPdfOutline', () => {
  it('flattens the tree in order with levels and resolved places', async () => {
    const entries = await flattenPdfOutline(doc, [
      {
        title: 'Chapter 1',
        dest: [ref(100), { name: 'XYZ' }, 0, 700, null],
        items: [{ title: ' Section\n1.1 ', dest: [ref(101), { name: 'FitH' }, 500] }],
      },
      { title: 'Chapter 2', dest: 'ch2' },
    ]);
    expect(entries).toEqual([
      { title: 'Chapter 1', level: 1, page: 0, top: 700 },
      { title: 'Section 1.1', level: 2, page: 1, top: 500 },
      { title: 'Chapter 2', level: 1, page: 4, top: null },
    ]);
  });

  it('drops entries that go nowhere but keeps what is under them', async () => {
    const entries = await flattenPdfOutline(doc, [
      {
        title: 'Web',
        items: [
          { title: 'Missing', dest: 'nope' },
          { title: 'Off the end', dest: [ref(150), { name: 'Fit' }] },
          { title: 'Kept', dest: [ref(103), { name: 'Fit' }] },
        ],
      },
      { title: '', dest: [ref(102), { name: 'Fit' }] },
    ]);
    expect(entries).toEqual([{ title: 'Kept', level: 2, page: 3, top: null }]);
  });

  it('stops three levels deep', async () => {
    const deep = (n: number): { title: string; dest: unknown; items?: unknown[] } => ({
      title: `L${n}`,
      dest: [ref(100), { name: 'Fit' }],
      items: n < 5 ? [deep(n + 1)] : undefined,
    });
    const entries = await flattenPdfOutline(doc, [deep(1) as never]);
    expect(entries.map((e) => e.title)).toEqual(['L1', 'L2', 'L3']);
  });

  it('is empty for a PDF with no outline', async () => {
    expect(await flattenPdfOutline(doc, null)).toEqual([]);
  });
});
