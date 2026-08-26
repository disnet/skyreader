import { describe, expect, it } from 'vitest';
import type { Article, SavedItem, SocialDocument, Subscription } from '$lib/types';
import { buildHighlightSourceLookups, resolveHighlightSource } from './highlightSource';

const article = {
  guid: 'article-guid',
  title: 'An Essay',
  url: 'https://example.com/essay',
  author: 'Ada Lovelace',
} as Article;

const anonymous = {
  guid: 'anon-guid',
  title: 'No Byline Here',
  url: 'https://elsewhere.test/piece',
} as Article;

const document = {
  recordUri: 'at://did:plc:writer/pub.leaflet.document/abc',
  title: 'A Post',
  authorDid: 'did:plc:writer',
  canonicalUrl: 'https://leaflet.pub/abc',
} as SocialDocument;

const save = {
  itemGuid: 'save-guid',
  uri: 'at://did:plc:me/app.skyreader.feed.saved/xyz',
  title: 'Something Saved',
  url: 'https://saved.test/thing',
  author: 'Grace Hopper',
} as SavedItem;

const subscription = {
  title: 'The Writer',
  subjectDid: 'did:plc:writer',
} as Subscription;

const lookups = buildHighlightSourceLookups(
  [article, anonymous],
  [document],
  [save],
  [subscription]
);

describe('resolveHighlightSource author', () => {
  it('takes the byline off an article', () => {
    expect(resolveHighlightSource('article-guid', 'article', lookups).author).toBe('Ada Lovelace');
  });

  it('names a document by the subscription it arrived under', () => {
    // A document carries only its author's DID, and resolving that to a profile
    // is an async fetch; the subscription is the same name, already on device.
    expect(resolveHighlightSource(document.recordUri, 'document', lookups).author).toBe(
      'The Writer'
    );
  });

  it('falls back to a saved copy for a highlight with no local article', () => {
    expect(resolveHighlightSource('save-guid', 'article', lookups).author).toBe('Grace Hopper');
  });

  it('is null rather than guessing when nothing carries a byline', () => {
    const source = resolveHighlightSource('anon-guid', 'article', lookups);
    expect(source.author).toBeNull();
    // The caller still has somewhere to fall back to.
    expect(source.domain).toBe('elsewhere.test');
  });

  it('is null for an imported highlight, which carries a title but no byline', () => {
    const source = resolveHighlightSource('https://margin.test/read', 'article', lookups, {
      sourceTitle: 'Read In Margin',
      sourceUrl: 'https://margin.test/read',
    });
    expect(source.author).toBeNull();
    expect(source.title).toBe('Read In Margin');
    expect(source.domain).toBe('margin.test');
  });
});
