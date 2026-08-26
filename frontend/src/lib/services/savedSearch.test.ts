import { describe, it, expect } from 'vitest';
import {
  htmlToText,
  makeSnippet,
  matchesSearch,
  matchesTerms,
  normalize,
  parseQuery,
  RANK_BODY,
  RANK_METADATA,
  RANK_TITLE,
  searchRank,
  splitHighlights,
  toIndexText,
  MAX_INDEX_CHARS,
} from './savedSearch';

describe('htmlToText', () => {
  it('strips tags and collapses whitespace', () => {
    expect(htmlToText('<p>Hello</p>\n<p>world</p>')).toBe('Hello world');
  });

  it('drops script and style bodies so they cannot produce phantom hits', () => {
    const html =
      '<div>Visible<script>var secretword = 1;</script><style>.a{color:red}</style></div>';
    const text = htmlToText(html);
    expect(text).toBe('Visible');
    expect(text).not.toContain('secretword');
  });

  it('decodes named and numeric entities', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &#8220;quoted&#8221; &#x2014; done</p>')).toBe(
      'Tom & Jerry “quoted” — done'
    );
  });

  it('strips comments and never emits markup', () => {
    expect(htmlToText('<!-- hidden --><b>shown</b>')).toBe('shown');
  });

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('normalize', () => {
  it('lowercases', () => {
    expect(normalize('MiXeD')).toBe('mixed');
  });

  it('folds diacritics so "café" matches "cafe"', () => {
    expect(normalize('Café')).toBe('cafe');
    expect(normalize('naïve résumé')).toBe('naive resume');
  });
});

describe('parseQuery', () => {
  it('splits on whitespace and normalizes', () => {
    expect(parseQuery('  Deep   Café ')).toEqual(['deep', 'cafe']);
  });

  it('dedupes repeated terms', () => {
    expect(parseQuery('rust rust')).toEqual(['rust']);
  });

  it('returns no terms for blank input', () => {
    expect(parseQuery('   ')).toEqual([]);
  });
});

describe('matchesTerms', () => {
  const hay = normalize('The quick brown fox jumps');

  it('requires every term (AND semantics)', () => {
    expect(matchesTerms(hay, ['quick', 'fox'])).toBe(true);
    expect(matchesTerms(hay, ['quick', 'cat'])).toBe(false);
  });

  it('matches substrings, not just whole words', () => {
    expect(matchesTerms(hay, ['ump'])).toBe(true);
  });

  it('treats an empty term list as "no filter"', () => {
    expect(matchesTerms(hay, [])).toBe(true);
    expect(matchesTerms('', [])).toBe(true);
  });

  it('never matches an empty haystack against real terms', () => {
    expect(matchesTerms('', ['a'])).toBe(false);
  });
});

describe('matchesSearch', () => {
  // "Ownership Explained": the title carries one term, the cached body another.
  const metadata = normalize('Ownership Explained example.com');
  const bodyTerms = new Map([['rkey1', new Set(['quokkatelemetry'])]]);
  const keys = () => ['rkey1'];

  it('lets each term of an AND query pick its own source', () => {
    expect(matchesSearch(metadata, ['ownership', 'quokkatelemetry'], bodyTerms, keys)).toBe(true);
  });

  it('still requires every term to hit somewhere', () => {
    expect(matchesSearch(metadata, ['ownership', 'sourdough'], bodyTerms, keys)).toBe(false);
    expect(matchesSearch(metadata, ['gardening', 'quokkatelemetry'], bodyTerms, keys)).toBe(false);
  });

  it('matches on a single source alone', () => {
    expect(matchesSearch(metadata, ['ownership'], bodyTerms, keys)).toBe(true);
    expect(matchesSearch(metadata, ['quokkatelemetry'], bodyTerms, keys)).toBe(true);
  });

  it('checks every key an item can be indexed under', () => {
    const byGuid = new Map([['guid-1', new Set(['quokkatelemetry'])]]);
    expect(
      matchesSearch(metadata, ['ownership', 'quokkatelemetry'], byGuid, () => ['rkey1', 'guid-1'])
    ).toBe(true);
    expect(matchesSearch(metadata, ['quokkatelemetry'], byGuid, () => ['rkey1'])).toBe(false);
  });

  it('degrades to metadata-only while the corpus is still building', () => {
    expect(matchesSearch(metadata, ['ownership'], null, keys)).toBe(true);
    expect(matchesSearch(metadata, ['ownership', 'quokkatelemetry'], null, keys)).toBe(false);
  });

  it('does not build the key list when metadata alone answers the query', () => {
    let built = 0;
    const counted = () => {
      built++;
      return ['rkey1'];
    };
    expect(matchesSearch(metadata, ['ownership'], bodyTerms, counted)).toBe(true);
    expect(built).toBe(0);
    expect(matchesSearch(metadata, ['ownership', 'quokkatelemetry'], bodyTerms, counted)).toBe(
      true
    );
    expect(built).toBe(1);
  });

  it('treats an empty query as no filter', () => {
    expect(matchesSearch(metadata, [], null, keys)).toBe(true);
  });
});

describe('searchRank', () => {
  const title = normalize('Café Ownership Explained');
  const metadata = normalize('Café Ownership Explained by Ada example.com');
  const bodyTerms = new Map([['guid-1', new Set(['quokkatelemetry'])]]);

  it('ranks all-title matches first, including pre-normalized diacritic matches', () => {
    expect(searchRank(title, metadata, ['cafe', 'ownership'], bodyTerms, () => ['rkey1'])).toBe(
      RANK_TITLE
    );
  });

  it('uses metadata rank when one term only appears outside the title', () => {
    expect(searchRank(title, metadata, ['ownership', 'ada'], bodyTerms, () => ['rkey1'])).toBe(
      RANK_METADATA
    );
  });

  it('uses body rank when a term matches the corpus under a secondary key', () => {
    expect(
      searchRank(title, metadata, ['ownership', 'quokkatelemetry'], bodyTerms, () => [
        'rkey1',
        'guid-1',
      ])
    ).toBe(RANK_BODY);
  });

  it('returns null when a term matches nowhere or the body corpus is unavailable', () => {
    expect(
      searchRank(title, metadata, ['ownership', 'sourdough'], bodyTerms, () => ['guid-1'])
    ).toBe(null);
    expect(searchRank(title, metadata, ['quokkatelemetry'], null, () => ['guid-1'])).toBe(null);
  });

  it('treats an empty query as a title-tier match', () => {
    expect(searchRank(title, metadata, [], null, () => [])).toBe(RANK_TITLE);
  });
});

describe('toIndexText', () => {
  it('strips, normalizes, and tolerates a null body', () => {
    expect(toIndexText('<p>Café <b>MOCHA</b></p>')).toBe('cafe mocha');
    expect(toIndexText(null)).toBe('');
  });

  it('caps a pathological body', () => {
    const long = 'a'.repeat(MAX_INDEX_CHARS + 5000);
    expect(toIndexText(long).length).toBe(MAX_INDEX_CHARS);
  });
});

describe('makeSnippet', () => {
  const text =
    'Paragraph one is about gardening. The particular phrase we want lives here in the middle. ' +
    'And the tail continues on for a while afterwards so both edges are truncated.';

  it('returns a window around the hit with the original casing', () => {
    const snip = makeSnippet(text, ['particular phrase'], 30);
    expect(snip).not.toBeNull();
    expect(snip!.match).toBe('particular phrase');
    expect(snip!.before + snip!.match + snip!.after).toBe(
      text.slice(
        text.indexOf(snip!.before),
        text.indexOf(snip!.before) + snip!.before.length + snip!.match.length + snip!.after.length
      )
    );
    expect(snip!.truncatedStart).toBe(true);
    expect(snip!.truncatedEnd).toBe(true);
  });

  it('finds a diacritic-folded hit and slices the accented original', () => {
    const snip = makeSnippet('We met at the Café Rouge today', ['cafe']);
    expect(snip!.match).toBe('Café');
  });

  it('reports untruncated edges at the string boundaries', () => {
    const snip = makeSnippet('alpha beta', ['alpha'], 100);
    expect(snip!.before).toBe('');
    expect(snip!.truncatedStart).toBe(false);
    expect(snip!.truncatedEnd).toBe(false);
    expect(snip!.after).toBe(' beta');
  });

  it('uses the earliest hit among terms', () => {
    const snip = makeSnippet('zebra then apple', ['apple', 'zebra']);
    expect(snip!.match).toBe('zebra');
  });

  it('returns null when nothing hits', () => {
    expect(makeSnippet(text, ['nonexistent'])).toBeNull();
    expect(makeSnippet('', ['a'])).toBeNull();
    expect(makeSnippet(text, [])).toBeNull();
  });
});

describe('splitHighlights', () => {
  it('marks each hit and leaves the rest alone', () => {
    const parts = splitHighlights('Rust and more Rust', ['rust']);
    expect(parts).toEqual([
      { text: 'Rust', mark: true },
      { text: ' and more ', mark: false },
      { text: 'Rust', mark: true },
    ]);
  });

  it('reassembles into the original text', () => {
    const title = 'Understanding Café Culture in Rust';
    const parts = splitHighlights(title, ['cafe', 'rust']);
    expect(parts.map((p) => p.text).join('')).toBe(title);
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(['Café', 'Rust']);
  });

  it('merges overlapping terms into one run', () => {
    const parts = splitHighlights('reading', ['read', 'reading']);
    expect(parts).toEqual([{ text: 'reading', mark: true }]);
  });

  it('returns the whole string unmarked when there are no terms or no hits', () => {
    expect(splitHighlights('title', [])).toEqual([{ text: 'title', mark: false }]);
    expect(splitHighlights('title', ['zzz'])).toEqual([{ text: 'title', mark: false }]);
  });
});
