import { describe, it, expect } from 'vitest';
import {
  rssSourceKey,
  sharesSourceKey,
  documentsSourceKey,
  parseSourceKey,
  isRssSource,
  isSharesSource,
  isDocumentsSource,
  getRssSubscriptionId,
  getSourceDid,
  subscriptionSourceKey,
  migrateLegacyView,
} from './sourceKeys';
import type { Subscription } from '$lib/types';

// ─── Construction ──────────────────────────────────────────────────────

describe('source key construction', () => {
  it('creates RSS source keys', () => {
    expect(rssSourceKey(42)).toBe('rss~42');
    expect(rssSourceKey(0)).toBe('rss~0');
  });

  it('creates shares source keys', () => {
    expect(sharesSourceKey('did:plc:abc123')).toBe('did:plc:abc123~shares');
  });

  it('creates documents source keys', () => {
    expect(documentsSourceKey('did:plc:abc123')).toBe('did:plc:abc123~documents');
  });
});

// ─── Parsing ───────────────────────────────────────────────────────────

describe('parseSourceKey', () => {
  it('parses RSS keys', () => {
    expect(parseSourceKey('rss~42')).toEqual({ kind: 'rss', id: '42' });
  });

  it('parses shares keys', () => {
    expect(parseSourceKey('did:plc:abc123~shares')).toEqual({
      kind: 'shares',
      id: 'did:plc:abc123',
    });
  });

  it('parses documents keys', () => {
    expect(parseSourceKey('did:plc:abc123~documents')).toEqual({
      kind: 'documents',
      id: 'did:plc:abc123',
    });
  });

  it('handles keys with no separator', () => {
    expect(parseSourceKey('nosep')).toEqual({ kind: 'nosep', id: '' });
  });
});

// ─── Type guards ───────────────────────────────────────────────────────

describe('type guards', () => {
  it('isRssSource', () => {
    expect(isRssSource('rss~42')).toBe(true);
    expect(isRssSource('did:plc:abc~shares')).toBe(false);
  });

  it('isSharesSource', () => {
    expect(isSharesSource('did:plc:abc~shares')).toBe(true);
    expect(isSharesSource('rss~42')).toBe(false);
  });

  it('isDocumentsSource', () => {
    expect(isDocumentsSource('did:plc:abc~documents')).toBe(true);
    expect(isDocumentsSource('did:plc:abc~shares')).toBe(false);
  });
});

// ─── Extractors ────────────────────────────────────────────────────────

describe('extractors', () => {
  it('getRssSubscriptionId', () => {
    expect(getRssSubscriptionId('rss~42')).toBe(42);
  });

  it('getSourceDid', () => {
    expect(getSourceDid('did:plc:abc123~shares')).toBe('did:plc:abc123');
  });
});

// ─── subscriptionSourceKey ─────────────────────────────────────────────

describe('subscriptionSourceKey', () => {
  const baseSub: Subscription = {
    rkey: 'abc',
    title: 'Test',
    tags: [],
    createdAt: '2024-01-01',
    localUpdatedAt: 0,
  };

  it('returns RSS key for RSS subscriptions', () => {
    expect(subscriptionSourceKey({ ...baseSub, id: 1 })).toBe('rss~1');
    expect(subscriptionSourceKey({ ...baseSub, id: 1, sourceType: 'rss' })).toBe('rss~1');
  });

  it('returns shares key for atproto.shares', () => {
    expect(
      subscriptionSourceKey({
        ...baseSub,
        id: 1,
        sourceType: 'atproto.shares',
        subjectDid: 'did:plc:x',
      })
    ).toBe('did:plc:x~shares');
  });

  it('returns documents key for atproto.documents', () => {
    expect(
      subscriptionSourceKey({
        ...baseSub,
        id: 1,
        sourceType: 'atproto.documents',
        subjectDid: 'did:plc:x',
      })
    ).toBe('did:plc:x~documents');
  });

  it('returns null when id is missing', () => {
    expect(subscriptionSourceKey(baseSub)).toBeNull();
  });

  it('returns null for atproto types without subjectDid', () => {
    expect(subscriptionSourceKey({ ...baseSub, id: 1, sourceType: 'atproto.shares' })).toBeNull();
  });
});

// ─── migrateLegacyView ────────────────────────────────────────────────

describe('migrateLegacyView', () => {
  const allSubIds = [1, 2, 3];
  const allDids = ['did:plc:a', 'did:plc:b'];

  it('all feeds + all accounts + all types → sourceMode all', () => {
    const result = migrateLegacyView({}, allSubIds, allDids);
    expect(result.sourceMode).toBe('all');
    expect(result.sourceKeys).toEqual([]);
  });

  it('no feeds + no accounts → include with empty keys', () => {
    const result = migrateLegacyView(
      { showArticles: false, showShares: false, showDocuments: false },
      allSubIds,
      allDids
    );
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toEqual([]);
  });

  it('include specific feeds', () => {
    const result = migrateLegacyView(
      { feedMode: 'include', feedIds: [1, 3], showShares: false, showDocuments: false },
      allSubIds,
      allDids
    );
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toEqual(['rss~1', 'rss~3']);
  });

  it('exclude specific feeds', () => {
    const result = migrateLegacyView(
      { feedMode: 'exclude', feedIds: [2], showShares: false, showDocuments: false },
      allSubIds,
      allDids
    );
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toEqual(['rss~1', 'rss~3']);
  });

  it('all feeds + include specific accounts with shares only', () => {
    const result = migrateLegacyView(
      { accountMode: 'include', accountDids: ['did:plc:a'], showDocuments: false },
      allSubIds,
      allDids
    );
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toContain('rss~1');
    expect(result.sourceKeys).toContain('rss~2');
    expect(result.sourceKeys).toContain('rss~3');
    expect(result.sourceKeys).toContain('did:plc:a~shares');
    expect(result.sourceKeys).not.toContain('did:plc:a~documents');
    expect(result.sourceKeys).not.toContain('did:plc:b~shares');
  });
});
