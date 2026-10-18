import { describe, expect, it } from 'bun:test';
import { doiFromMetaTags } from './citation-ids';
import { extractArticle } from './app';

const BODY =
  '<article><h1>A paper</h1><p>' +
  'We study how readers come to understand what they read. '.repeat(20) +
  '</p></article>';

function page(head: string): string {
  return `<html><head><title>A paper</title>${head}</head><body>${BODY}</body></html>`;
}

describe('doiFromMetaTags', () => {
  it('reads citation_doi', () => {
    expect(doiFromMetaTags([{ name: 'citation_doi', content: '10.1145/3290605.3300233' }])).toBe(
      '10.1145/3290605.3300233'
    );
  });

  it('takes the DOI out of doi:, info:doi/ and doi.org forms', () => {
    for (const content of [
      'doi:10.1038/nature12373',
      'DOI: 10.1038/nature12373',
      'info:doi/10.1038/nature12373',
      'https://doi.org/10.1038/nature12373',
      'http://dx.doi.org/10.1038/nature12373',
      'https://www.doi.org/10.1038/nature12373',
      'https://doi.org/10.1038%2Fnature12373',
    ]) {
      expect(doiFromMetaTags([{ name: 'citation_doi', content }])).toBe('10.1038/nature12373');
    }
  });

  it('matches tag names case-insensitively, by name or property', () => {
    expect(doiFromMetaTags([{ name: 'DC.Identifier', content: '10.1000/xyz' }])).toBe(
      '10.1000/xyz'
    );
    expect(doiFromMetaTags([{ property: 'prism.doi', content: '10.1000/xyz' }])).toBe(
      '10.1000/xyz'
    );
  });

  it('prefers citation_doi over dc.identifier, whatever their order', () => {
    expect(
      doiFromMetaTags([
        { name: 'dc.identifier', content: '10.1000/other' },
        { name: 'citation_doi', content: '10.1000/xyz' },
      ])
    ).toBe('10.1000/xyz');
  });

  it("skips a dc.identifier that isn't a DOI and takes a later one that is", () => {
    expect(
      doiFromMetaTags([
        { name: 'dc.identifier', content: 'ISBN 978-3-16-148410-0' },
        { name: 'dc.identifier', content: 'https://example.com/a?ref=10.1000/xyz' },
        { name: 'dc.identifier', content: 'doi:10.1000/xyz' },
      ])
    ).toBe('10.1000/xyz');
  });

  it('is null with no DOI tag', () => {
    expect(doiFromMetaTags([{ name: 'description', content: 'see 10.1000/xyz' }])).toBeNull();
    expect(doiFromMetaTags([{ name: 'citation_doi', content: null }])).toBeNull();
    expect(doiFromMetaTags(undefined)).toBeNull();
  });
});

describe('extractArticle', () => {
  it("carries the page's declared DOI", async () => {
    const article = await extractArticle(
      page('<meta name="citation_doi" content="10.1145/3290605.3300233">'),
      'https://dl.example.org/paper/42'
    );
    expect(article.doi).toBe('10.1145/3290605.3300233');
  });

  it('has no DOI for a page that declares none', async () => {
    const article = await extractArticle(page(''), 'https://example.org/post');
    expect(article.doi).toBeNull();
  });
});
