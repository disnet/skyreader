import { describe, it, expect } from 'vitest';
import { mergeSubscriptionRecord } from '../src/services/subscription-sync';

const COLLECTION = 'app.skyreader.feed.subscription';

describe('mergeSubscriptionRecord', () => {
  const existing = {
    $type: COLLECTION,
    feedUrl: 'https://example.com/feed.xml',
    title: 'Example',
    siteUrl: 'https://author.example/links',
    category: 'Old',
    createdAt: '2026-08-30T18:20:34.267Z',
    source: 'opml',
    tags: ['a'],
    collectionNsid: 'site.standard.document',
  };

  it('keeps what Skyreader does not model, and the original createdAt', () => {
    const merged = mergeSubscriptionRecord(existing, {
      feedUrl: 'https://example.com/feed.xml',
      title: 'Example',
      siteUrl: 'https://author.example/links',
      category: 'Tech',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    expect(merged).toMatchObject({
      category: 'Tech',
      source: 'opml',
      tags: ['a'],
      collectionNsid: 'site.standard.document',
      createdAt: '2026-08-30T18:20:34.267Z',
    });
  });

  it('removes a field Skyreader owns once D1 no longer has it', () => {
    // A hidden linkblog page clears siteUrl on its followers' rows.
    const merged = mergeSubscriptionRecord(existing, {
      feedUrl: 'https://example.com/feed.xml',
      title: 'Example',
      siteUrl: undefined,
      category: undefined,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    expect(merged).not.toHaveProperty('siteUrl');
    expect(merged).not.toHaveProperty('category');
  });

  it('moves an updatedAt the record keeps', () => {
    const merged = mergeSubscriptionRecord(
      { ...existing, updatedAt: '2026-08-30T18:20:34.267Z' },
      { feedUrl: 'https://example.com/feed.xml', createdAt: '2026-11-01T00:00:00.000Z' }
    );
    expect((merged as unknown as { updatedAt: string }).updatedAt).not.toBe(
      '2026-08-30T18:20:34.267Z'
    );
  });
});
