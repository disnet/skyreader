import { describe, expect, it } from 'bun:test';
import { idsFromUrl, paperVariantUrls } from './paper-variants';

describe('idsFromUrl', () => {
  it('reads DOIs and arXiv ids from the well-known shapes', () => {
    expect(idsFromUrl('https://doi.org/10.1145/3290605.3300233')).toEqual({
      doi: '10.1145/3290605.3300233',
    });
    expect(idsFromUrl('https://dl.acm.org/doi/pdf/10.1145/3290605.3300233.pdf')).toEqual({
      doi: '10.1145/3290605.3300233',
    });
    expect(idsFromUrl('https://arxiv.org/pdf/2401.12345v3')).toEqual({ arxivId: '2401.12345' });
    expect(idsFromUrl('https://arxiv.org/abs/hep-th/9901001')).toEqual({
      arxivId: 'hep-th/9901001',
    });
    expect(idsFromUrl('https://www.biorxiv.org/content/10.1101/2020.01.01.123456v2')).toEqual({
      doi: '10.1101/2020.01.01.123456',
    });
    expect(idsFromUrl('https://example.com/blog/post')).toEqual({});
    expect(idsFromUrl('not a url')).toEqual({});
  });
});

describe('paperVariantUrls', () => {
  it("gives an arXiv paper's other addresses, never the page's own", () => {
    expect(paperVariantUrls('https://arxiv.org/abs/2401.12345')).toEqual([
      'https://arxiv.org/pdf/2401.12345',
      'https://doi.org/10.48550/arXiv.2401.12345',
    ]);
  });

  it("gives a publisher page's doi.org link, from its address or its declared DOI", () => {
    expect(paperVariantUrls('https://onlinelibrary.wiley.com/doi/full/10.1002/abc.123')).toEqual([
      'https://doi.org/10.1002/abc.123',
    ]);
    expect(paperVariantUrls('https://example.org/paper', '10.5555/xyz')).toEqual([
      'https://doi.org/10.5555/xyz',
    ]);
  });

  it("prefers the address's DOI over a declared one", () => {
    expect(paperVariantUrls('https://doi.org/10.1/a', '10.1/b')).toEqual([]);
  });

  it('ignores a declared value that is not a DOI, and pages with no identifier', () => {
    expect(paperVariantUrls('https://example.org/paper', 'isbn:123')).toEqual([]);
    expect(paperVariantUrls('https://example.org/paper')).toEqual([]);
    // A # would cut the doi.org link short, onto another DOI.
    expect(paperVariantUrls('https://example.org/paper', '10.1000/abc#2')).toEqual([]);
  });
});
