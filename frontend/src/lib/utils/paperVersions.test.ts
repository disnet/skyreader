import { describe, expect, it } from 'vitest';
import { doiFromUrl, otherVersions, paperKey, versionLabel } from './paperVersions';
import type { SavedItem } from '$lib/types';

function save(rkey: string, url: string, extra: Partial<SavedItem> = {}): SavedItem {
  return {
    rkey,
    uri: `at://did:plc:me/app.skyreader.feed.saved/${rkey}`,
    url,
    title: rkey,
    author: null,
    description: null,
    content: null,
    contentType: 'webpage',
    domain: null,
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

describe('doiFromUrl', () => {
  it('reads the DOI the well-known paper addresses name', () => {
    expect(doiFromUrl('https://doi.org/10.1145/3290605.3300233')).toBe('10.1145/3290605.3300233');
    expect(doiFromUrl('https://dl.acm.org/doi/pdf/10.1145/3290605.3300233.pdf')).toBe(
      '10.1145/3290605.3300233'
    );
    expect(doiFromUrl('https://arxiv.org/pdf/2401.12345v2')).toBe('10.48550/arXiv.2401.12345');
    expect(doiFromUrl('https://www.biorxiv.org/content/10.1101/2020.01.01.123456v2')).toBe(
      '10.1101/2020.01.01.123456'
    );
    expect(doiFromUrl('https://example.com/2010.html')).toBeUndefined();
    expect(doiFromUrl('')).toBeUndefined();
  });
});

describe('DOIs, as the backend reads them', () => {
  it('keeps a bracket the DOI opened and drops one it did not', () => {
    expect(doiFromUrl('https://doi.org/10.1002/(SICI)1097-4571(199806)49:8')).toBe(
      '10.1002/(SICI)1097-4571(199806)49:8'
    );
    expect(doiFromUrl('https://doi.org/10.5555/abc)')).toBe('10.5555/abc');
    expect(doiFromUrl('https://doi.org/10.5555/')).toBeUndefined();
  });

  it('takes a declared DOI only when it is a DOI and nothing else', () => {
    expect(paperKey({ url: 'https://example.com/a', doi: '10.5555/ABC' })).toBe('doi:10.5555/abc');
    expect(paperKey({ url: 'https://example.com/a', doi: '10.5555/abc.' })).toBeUndefined();
    expect(paperKey({ url: 'https://example.com/a', doi: 'doi:10.5555/abc' })).toBeUndefined();
  });
});

describe('otherVersions', () => {
  it("finds a paper's other saves by DOI, URL or declared, first saved first", () => {
    const abs = save('a', 'https://arxiv.org/abs/2401.12345', { savedAt: '2026-01-02T00:00:00Z' });
    const pdf = save('b', 'https://arxiv.org/pdf/2401.12345', { contentType: 'pdf' });
    const journal = save('c', 'https://journal.example/7', { doi: '10.5555/ABC' });
    const link = save('d', 'https://doi.org/10.5555/abc');
    const blog = save('e', 'https://blog.example/post');
    const all = [abs, pdf, journal, link, blog];
    expect(otherVersions(abs, all).map((s) => s.rkey)).toEqual(['b']);
    expect(otherVersions(link, all).map((s) => s.rkey)).toEqual(['c']);
    expect(otherVersions(blog, all)).toEqual([]);
    expect(paperKey(journal)).toBe('doi:10.5555/abc');
  });

  it('names a version the way a reader would', () => {
    expect(versionLabel(save('a', 'https://arxiv.org/pdf/1', { contentType: 'pdf' }))).toBe(
      'the PDF'
    );
    expect(versionLabel(save('a', 'https://arxiv.org/abs/1'))).toBe('the arXiv page');
    expect(versionLabel(save('a', 'https://doi.org/10.1/x'))).toBe('the DOI link');
    expect(versionLabel(save('a', 'https://www.nature.com/articles/x'))).toBe(
      'the nature.com page'
    );
  });
});
