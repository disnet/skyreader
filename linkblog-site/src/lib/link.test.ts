import { describe, expect, it } from 'vitest';
import {
  clipText,
  hueClassFor,
  monogramFor,
  relativeTime,
  readPageUrlFor,
  articleUrlFromPage,
  countPhrases,
  isArticlePath,
  pageSections,
  curatorEntry,
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

  it('hands the query back byte for byte', () => {
    expect(read('/https://example.com/a?q=a%20b&flag&x=b=c')).toBe(
      'https://example.com/a?q=a%20b&flag&x=b=c'
    );
    expect(read('/https://example.com/a?q=a%20b&skyreader_refresh=2')).toBe(
      'https://example.com/a?q=a%20b'
    );
    expect(read('/https://example.com/a?skyreader_refresh=2')).toBe('https://example.com/a');
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
    expect(sections.connections).toEqual([]);
  });

  it("carries Semble's connections, and lays a curator out as a row's person", () => {
    const connection = {
      id: 'c1',
      direction: 'out' as const,
      type: 'supports',
      note: 'see this',
      createdAt: null,
      curator: { did: 'did:plc:k', handle: '', name: 'Kit', avatarUrl: null },
      other: { url: 'https://other.example/', title: 'Other', siteName: null },
    };
    const sections = pageSections({
      entries: {},
      semble: { connections: [connection], cardUrl: null },
    });
    expect(sections.connections).toEqual([connection]);
    expect(curatorEntry(connection)).toMatchObject({
      did: 'did:plc:k',
      handle: null,
      displayName: 'Kit',
      note: 'see this',
      collections: [],
    });
  });
});

describe('readPageUrlFor', () => {
  it('hands linkblog hosts off to their read host', () => {
    expect(readPageUrlFor('https://linkblogs.skyreader.app', 'https://example.com/a?b=1')).toBe(
      'https://read.skyreader.app/https://example.com/a?b=1'
    );
    expect(readPageUrlFor('https://staging-linkblogs.skyreader.app', 'https://example.com/a')).toBe(
      'https://staging-read.skyreader.app/https://example.com/a'
    );
  });

  it('drops the fragment, and names no page for an article the read host would refuse', () => {
    expect(readPageUrlFor('https://linkblogs.skyreader.app', 'https://example.com/a#s')).toBe(
      'https://read.skyreader.app/https://example.com/a'
    );
    expect(readPageUrlFor('https://linkblogs.skyreader.app', 'https://intranet/a')).toBeNull();
  });

  it('stays on the origin on a read host and in local dev', () => {
    expect(readPageUrlFor('https://read.skyreader.app', 'https://example.com/a')).toBe(
      'https://read.skyreader.app/https://example.com/a'
    );
    expect(readPageUrlFor('http://127.0.0.1:5175', 'https://example.com/a')).toBe(
      'http://127.0.0.1:5175/link/https://example.com/a'
    );
  });
});

describe('entry rows', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  it('says when, the way the panel does', () => {
    expect(relativeTime('2026-10-15T00:00:00Z', now)).toBe('3w ago');
    expect(relativeTime('2026-11-04T22:00:00Z', now)).toBe('2h ago');
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });

  it('gives everyone a monogram and a stable tint', () => {
    expect(monogramFor({ did: 'did:plc:x', handle: 'jo.kim', displayName: null })).toBe('J');
    expect(monogramFor({ did: 'did:plc:abc', handle: null, displayName: '  ' })).toBe('A');
    expect(hueClassFor('did:plc:x')).toBe(hueClassFor('did:plc:x'));
    expect(hueClassFor('did:plc:x')).toMatch(/^hue-[0-7]$/);
  });
});

describe('note text', () => {
  it('clips a long note at a word boundary', () => {
    const long = 'word '.repeat(100).trim();
    const clipped = clipText(long, 50);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text.endsWith('word…')).toBe(true);
    expect(clipText('short', 50)).toEqual({ text: 'short', clipped: false });
  });
});
