import { describe, it, expect } from 'vitest';
import type { Article, FilteredView, Highlight, SavedItem, SocialDocument } from '$lib/types';
import { contextFor, itemForReader, nudgeCount, type ContextSources } from './items';

const DOC = 'at://did:plc:abc/site.standard.document/3kabc';

const article = (over: Partial<Article> = {}): Article =>
  ({
    subscriptionId: 7,
    guid: 'guid-1',
    url: 'https://example.com/post',
    title: 'A post',
    publishedAt: '',
    fetchedAt: 0,
    ...over,
  }) as Article;

const save = (over: Partial<SavedItem> = {}): SavedItem =>
  ({
    rkey: 'r1',
    uri: 'at://did:plc:me/app.skyreader.feed.saved/r1',
    url: 'https://example.com/post',
    title: 'A post',
    savedAt: '',
    ...over,
  }) as SavedItem;

const highlight = (id: string, exact: string, over: Partial<Highlight> = {}): Highlight => ({
  id,
  selector: { type: 'TextQuoteSelector', exact },
  createdAt: Number(id.replace(/\D/g, '')) || 0,
  ...over,
});

function sources(over: Partial<ContextSources> = {}): ContextSources {
  return {
    findSave: () => undefined,
    articles: [],
    feedTitle: () => undefined,
    documents: [],
    highlightsFor: () => [],
    allHighlights: [],
    ...over,
  };
}

describe('itemForReader', () => {
  it('gives an article its page', () => {
    expect(itemForReader({ type: 'article', item: article(), key: 'guid-1' }, 'A post')).toEqual({
      title: 'A post',
      url: 'https://example.com/post',
    });
  });

  it('gives a document its record and page', () => {
    const doc = { recordUri: DOC, canonicalUrl: 'https://blog.test/a' } as SocialDocument;
    expect(itemForReader({ type: 'document', item: doc, key: DOC }, 'Doc')).toEqual({
      title: 'Doc',
      uri: DOC,
      url: 'https://blog.test/a',
    });
  });

  it("never names a save's own row as a record", () => {
    expect(itemForReader({ type: 'saved', item: save(), key: 'k' }, 'A post')).toEqual({
      title: 'A post',
      url: 'https://example.com/post',
    });
    expect(
      itemForReader({ type: 'saved', item: save({ itemGuid: DOC }), key: 'k' }, 'A post').uri
    ).toBe(DOC);
  });
});

describe('nudgeCount', () => {
  it('adds up only the channels marked worth a nudge', () => {
    const views = [
      { id: 1, nudge: true },
      { id: 2 },
      { id: 3, nudge: true },
      { nudge: true },
    ] as FilteredView[];
    const counts = new Map([
      [1, 4],
      [2, 10],
      [3, 1],
    ]);
    expect(nudgeCount(views, counts)).toBe(5);
    expect(nudgeCount([{ id: 2 }] as FilteredView[], counts)).toBe(0);
  });
});

describe('contextFor', () => {
  it('has nothing for an item with no page or record', () => {
    expect(contextFor({ title: 'x' }, sources())).toEqual([]);
  });

  it('finds the save, the feed and the highlights by URL', () => {
    const s = save({ itemGuid: 'guid-1' });
    const items = contextFor(
      { title: 'Elsewhere', url: 'https://example.com/post/?utm_source=x' },
      sources({
        findSave: (k) => (k === 'https://example.com/post/?utm_source=x' ? s : undefined),
        articles: [article()],
        feedTitle: (id) => (id === 7 ? 'Example' : undefined),
        highlightsFor: (k) =>
          k === 'guid-1' ? [highlight('h2', 'the  quote', { note: 'mine' })] : [],
        allHighlights: [
          { highlight: highlight('h1', 'older', { sourceUrl: 'https://example.com/post' }) },
          { highlight: highlight('h9', 'other page', { sourceUrl: 'https://other.test/' }) },
        ],
      })
    );
    expect(items.map((i) => i.text)).toEqual([
      'Saved in Skyreader',
      'In your feeds · Example',
      'the quote · mine',
      'older',
    ]);
    expect(items[0].title).toBe('A post');
    expect(items[2].title).toBe('Your highlight');
  });

  it('finds a document by its record', () => {
    const doc = {
      recordUri: DOC,
      title: 'Doc',
      canonicalUrl: 'https://blog.test/a',
    } as SocialDocument;
    expect(contextFor({ title: 'Doc', uri: DOC }, sources({ documents: [doc] }))).toEqual([
      { title: 'Doc', uri: DOC, url: 'https://blog.test/a', text: 'In your feeds' },
    ]);
  });

  it('counts a highlight once however many keys find it', () => {
    const h = highlight('h1', 'once', { sourceUrl: 'https://example.com/post' });
    const items = contextFor(
      { title: 'x', url: 'https://example.com/post' },
      sources({ highlightsFor: () => [h], allHighlights: [{ highlight: h }] })
    );
    expect(items.filter((i) => i.title === 'Your highlight')).toHaveLength(1);
  });
});
