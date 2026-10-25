import { describe, expect, it } from 'vitest';
import {
  articleUrlFromPage,
  countPhrases,
  isArticlePath,
  pageSections,
  refreshPath,
  safeArticleUrl,
  type LinkEntry,
} from './link';

const read = (path: string) => articleUrlFromPage(new URL(`https://read.skyreader.app${path}`));
const dev = (path: string) => articleUrlFromPage(new URL(`http://127.0.0.1:5175${path}`));

describe('articleUrlFromPage', () => {
  it('reads the article off a read host path, keeping its query', () => {
    expect(read('/https://example.com/post?id=7')).toBe('https://example.com/post?id=7');
  });

  it('repairs a scheme whose slashes were merged, and adds a missing one', () => {
    expect(read('/https:/example.com/post')).toBe('https://example.com/post');
    expect(read('/example.com/post')).toBe('https://example.com/post');
  });

  it('drops only our own refresh counter from the query', () => {
    expect(read('/https://example.com/post?a=1&skyreader_refresh=3')).toBe(
      'https://example.com/post?a=1'
    );
  });

  it('lives under /link off a read host', () => {
    expect(dev('/link/https://example.com/post')).toBe('https://example.com/post');
  });

  it('names no article for the landing page or a non-URL', () => {
    expect(read('/')).toBeNull();
    expect(dev('/link')).toBeNull();
    expect(read('/nonsense')).toBeNull();
    expect(read('/javascript:alert(1)')).toBeNull();
  });
});

describe('refreshPath', () => {
  // `//evil.example/x` names the article https://evil.example/x; refreshing to the
  // visitor's own path would send them to another site.
  it('always stays on this site', () => {
    const article = read('//evil.example/x')!;
    expect(article).toBe('https://evil.example/x');
    const path = refreshPath('read.skyreader.app', article, 1);
    expect(path).toBe('/https://evil.example/x?skyreader_refresh=1');
    expect(new URL(path, 'https://read.skyreader.app').origin).toBe('https://read.skyreader.app');
  });

  it('appends the counter to an existing query, and keeps the /link prefix off a read host', () => {
    expect(refreshPath('127.0.0.1', 'https://example.com/p?a=1', 2)).toBe(
      '/link/https://example.com/p?a=1&skyreader_refresh=2'
    );
  });
});

describe('isArticlePath', () => {
  it('keeps the files browsers and crawlers ask for out of the lookup', () => {
    for (const path of ['/favicon.ico', '/robots.txt', '/apple-touch-icon-precomposed.png']) {
      expect(isArticlePath(path)).toBe(false);
    }
    expect(isArticlePath('/.well-known/security.txt')).toBe(false);
    expect(isArticlePath('/https://example.com/robots.txt')).toBe(true);
  });
});

describe('safeArticleUrl', () => {
  it('accepts http(s) URLs with a real host only', () => {
    expect(safeArticleUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeArticleUrl('https://localhost/a')).toBeNull();
    expect(safeArticleUrl('ftp://example.com/a')).toBeNull();
    expect(safeArticleUrl(`https://example.com/${'a'.repeat(2100)}`)).toBeNull();
  });
});

describe('countPhrases', () => {
  it('pluralizes per lane and marks a capped count', () => {
    const lane = (noun: string, count: number, capped = false) => ({
      lane: noun,
      label: noun,
      verb: 'posted',
      noun,
      count,
      capped,
    });
    expect(countPhrases([lane('Bluesky post', 1), lane('linkblog note', 3), lane('x', 0)])).toEqual(
      ['1 Bluesky post', '3 linkblog notes']
    );
    expect(countPhrases([lane('Bluesky post', 200, true)])).toEqual(['200+ Bluesky posts']);
  });
});

describe('pageSections', () => {
  const entry = (did: string, extra: Partial<LinkEntry> = {}): LinkEntry => ({
    did,
    handle: null,
    displayName: null,
    avatar: null,
    createdAt: null,
    note: null,
    url: null,
    verb: null,
    quote: null,
    collections: [],
    ...extra,
  });

  it('splits Margin notes into highlights and discussion, commentary first', () => {
    const sections = pageSections({
      entries: {
        bluesky: [entry('b')],
        linkblog: [entry('l')],
        margin: [entry('h', { quote: 'a passage' }), entry('c', { note: 'a comment' }), entry('e')],
        semble: [entry('s')],
      },
    });
    expect(sections.highlights.map((e) => e.did)).toEqual(['h']);
    expect(sections.discussion.map((e) => e.did)).toEqual(['l', 'b', 'c']);
    expect(sections.saves.map((e) => e.did)).toEqual(['s']);
  });
});
