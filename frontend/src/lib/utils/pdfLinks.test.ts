import { describe, expect, it } from 'vitest';
import { destinationTop, pdfLinkHref, resolvePdfLink, type PdfLinkDoc } from './pdfLinks';

// Five pages whose objects are numbered 10, 20, ...; one named destination.
const doc: PdfLinkDoc = {
  numPages: 5,
  getDestination: async (name) =>
    name === 'section.3' ? [{ num: 30, gen: 0 }, { name: 'XYZ' }, 72, 540, null] : null,
  getPageIndex: async (ref) => {
    if (ref.num % 10 || ref.num > 50) throw new Error('Invalid pageIndex request.');
    return ref.num / 10 - 1;
  },
};

describe('pdfLinkHref', () => {
  it('keeps web and mail links', () => {
    expect(pdfLinkHref('https://arxiv.org/abs/1706.03762')).toBe(
      'https://arxiv.org/abs/1706.03762'
    );
    expect(pdfLinkHref('mailto:ada@example.com')).toBe('mailto:ada@example.com');
  });

  it('drops script, file and relative links', () => {
    expect(pdfLinkHref('javascript:app.alert(1)')).toBeNull();
    expect(pdfLinkHref('file:///etc/passwd')).toBeNull();
    expect(pdfLinkHref('chapter2.pdf')).toBeNull();
    expect(pdfLinkHref(undefined)).toBeNull();
  });
});

describe('destinationTop', () => {
  it('reads the y each kind carries', () => {
    expect(destinationTop([0, { name: 'XYZ' }, 72, 600, 0])).toBe(600);
    expect(destinationTop([0, { name: 'FitH' }, 400])).toBe(400);
    expect(destinationTop([0, { name: 'FitBH' }, 300])).toBe(300);
    expect(destinationTop([0, { name: 'FitR' }, 10, 20, 300, 500])).toBe(500);
  });

  it('is the page top for a whole-page fit or an unset y', () => {
    expect(destinationTop([0, { name: 'Fit' }])).toBeNull();
    expect(destinationTop([0, { name: 'FitV' }, 72])).toBeNull();
    expect(destinationTop([0, { name: 'XYZ' }, null, null, null])).toBeNull();
  });
});

describe('resolvePdfLink', () => {
  const link = (props: object) => ({ subtype: 'Link', rect: [0, 0, 10, 10], ...props });

  it('follows an explicit destination by page reference', async () => {
    expect(
      await resolvePdfLink(doc, link({ dest: [{ num: 40, gen: 0 }, { name: 'FitH' }, 700] }), 0)
    ).toEqual({ kind: 'page', page: 3, top: 700 });
  });

  it('follows an explicit destination by page index', async () => {
    expect(await resolvePdfLink(doc, link({ dest: [2, { name: 'Fit' }] }), 0)).toEqual({
      kind: 'page',
      page: 2,
      top: null,
    });
  });

  it('looks up a named destination', async () => {
    expect(await resolvePdfLink(doc, link({ dest: 'section.3' }), 0)).toEqual({
      kind: 'page',
      page: 2,
      top: 540,
    });
  });

  it('goes nowhere for a missing name, a dangling reference or a page past the end', async () => {
    expect(await resolvePdfLink(doc, link({ dest: 'cite.missing' }), 0)).toBeNull();
    expect(
      await resolvePdfLink(doc, link({ dest: [{ num: 99, gen: 0 }, { name: 'Fit' }] }), 0)
    ).toBeNull();
    expect(await resolvePdfLink(doc, link({ dest: [7, { name: 'Fit' }] }), 0)).toBeNull();
  });

  it('opens a web link', async () => {
    expect(await resolvePdfLink(doc, link({ url: 'https://example.com/' }), 0)).toEqual({
      kind: 'url',
      href: 'https://example.com/',
    });
  });

  it('ignores an unsafe URL', async () => {
    expect(await resolvePdfLink(doc, link({ url: 'javascript:void(0)' }), 0)).toBeNull();
  });

  it('moves by named action relative to the link’s page', async () => {
    expect(await resolvePdfLink(doc, link({ action: 'NextPage' }), 1)).toEqual({
      kind: 'page',
      page: 2,
      top: null,
    });
    expect(await resolvePdfLink(doc, link({ action: 'LastPage' }), 1)).toMatchObject({ page: 4 });
    expect(await resolvePdfLink(doc, link({ action: 'PrevPage' }), 0)).toBeNull();
    expect(await resolvePdfLink(doc, link({ action: 'Print' }), 0)).toBeNull();
  });

  it('skips annotations that are not links', async () => {
    expect(
      await resolvePdfLink(doc, { subtype: 'Widget', url: 'https://example.com/' }, 0)
    ).toBeNull();
  });
});
