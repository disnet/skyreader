import { describe, it, expect } from 'vitest';
import {
  rssSourceKey,
  documentsSourceKey,
  parseSourceKey,
  isRssSource,
  isDocumentsSource,
  getRssSubscriptionRkey,
  getSourceDid,
  subscriptionSourceKey,
  migrateLegacyView,
  resolveDocScopes,
  docInAnyScope,
} from './sourceKeys';
import type { Subscription } from '$lib/types';

// ─── Construction ──────────────────────────────────────────────────────

describe('source key construction', () => {
  it('creates RSS source keys', () => {
    expect(rssSourceKey('3l7e5x2b7ik2c')).toBe('rss~3l7e5x2b7ik2c');
    expect(rssSourceKey('abc')).toBe('rss~abc');
  });

  it('creates documents source keys from a subscription rkey', () => {
    expect(documentsSourceKey('3l7e5x2b7ik2c')).toBe('3l7e5x2b7ik2c~documents');
  });
});

// ─── Parsing ───────────────────────────────────────────────────────────

describe('parseSourceKey', () => {
  it('parses RSS keys', () => {
    expect(parseSourceKey('rss~3l7e5x2b7ik2c')).toEqual({
      kind: 'rss',
      id: '3l7e5x2b7ik2c',
    });
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
    expect(isRssSource('rss~3l7e5x2b7ik2c')).toBe(true);
    expect(isRssSource('did:plc:abc~documents')).toBe(false);
  });

  it('isDocumentsSource', () => {
    expect(isDocumentsSource('did:plc:abc~documents')).toBe(true);
    expect(isDocumentsSource('rss~abc')).toBe(false);
  });
});

// ─── Extractors ────────────────────────────────────────────────────────

describe('extractors', () => {
  it('getRssSubscriptionRkey', () => {
    expect(getRssSubscriptionRkey('rss~3l7e5x2b7ik2c')).toBe('3l7e5x2b7ik2c');
  });

  it('getSourceDid', () => {
    expect(getSourceDid('did:plc:abc123~documents')).toBe('did:plc:abc123');
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
    expect(subscriptionSourceKey({ ...baseSub, id: 1 })).toBe('rss~abc');
    expect(subscriptionSourceKey({ ...baseSub, id: 1, sourceType: 'rss' })).toBe('rss~abc');
  });

  it('returns documents key (by rkey) for atproto.documents', () => {
    expect(
      subscriptionSourceKey({
        ...baseSub,
        id: 1,
        sourceType: 'atproto.documents',
        subjectDid: 'did:plc:x',
      })
    ).toBe('abc~documents');
  });

  it('returns null when rkey is missing', () => {
    expect(subscriptionSourceKey({ ...baseSub, rkey: '' })).toBeNull();
  });

  it('keys atproto.documents by rkey even without subjectDid (scope resolved later)', () => {
    expect(
      subscriptionSourceKey({
        ...baseSub,
        id: 1,
        sourceType: 'atproto.documents',
      })
    ).toBe('abc~documents');
  });
});

// ─── Documents scope resolution ────────────────────────────────────────

describe('resolveDocScopes / docInAnyScope', () => {
  // Two publications owned by one author DID, plus a third author.
  const subs = [
    {
      rkey: 'rk-blog',
      sourceType: 'atproto.documents' as const,
      subjectDid: 'did:plc:a',
      feedUrl: 'at://did:plc:a/site.standard.publication/blog',
    },
    {
      rkey: 'rk-links',
      sourceType: 'atproto.documents' as const,
      subjectDid: 'did:plc:a',
      feedUrl: 'at://did:plc:a/site.standard.publication/links',
    },
    {
      rkey: 'rk-b',
      sourceType: 'atproto.documents' as const,
      subjectDid: 'did:plc:b',
      feedUrl: '',
    },
  ];

  it('resolves an rkey key to its publication scope', () => {
    expect(resolveDocScopes(['rk-blog~documents'], subs)).toEqual([
      { did: 'did:plc:a', pub: 'at://did:plc:a/site.standard.publication/blog' },
    ]);
  });

  it('keeps two publications of one author distinct', () => {
    const blog = {
      authorDid: 'did:plc:a',
      siteUri: 'at://did:plc:a/site.standard.publication/blog',
    };
    const links = {
      authorDid: 'did:plc:a',
      siteUri: 'at://did:plc:a/site.standard.publication/links',
    };
    const blogScope = resolveDocScopes(['rk-blog~documents'], subs);
    expect(docInAnyScope(blog, blogScope)).toBe(true);
    expect(docInAnyScope(links, blogScope)).toBe(false);
  });

  it('treats a legacy {did}~documents key as the whole author', () => {
    const scopes = resolveDocScopes(['did:plc:a~documents'], subs);
    expect(scopes).toEqual([{ did: 'did:plc:a' }]);
    const links = {
      authorDid: 'did:plc:a',
      siteUri: 'at://did:plc:a/site.standard.publication/links',
    };
    expect(docInAnyScope(links, scopes)).toBe(true);
  });

  it('covers all of an author when the subscription has no publication scope', () => {
    const scopes = resolveDocScopes(['rk-b~documents'], subs);
    expect(scopes).toEqual([{ did: 'did:plc:b', pub: undefined }]);
    expect(docInAnyScope({ authorDid: 'did:plc:b', siteUri: 'whatever' }, scopes)).toBe(true);
  });

  it('ignores non-documents keys and unresolvable rkeys', () => {
    expect(resolveDocScopes(['rss~rk-blog', 'rk-missing~documents'], subs)).toEqual([]);
  });
});

// ─── migrateLegacyView ────────────────────────────────────────────────

describe('migrateLegacyView', () => {
  const allSubRkeys = ['rk1', 'rk2', 'rk3'];
  const allDids = ['did:plc:a', 'did:plc:b'];
  const idToRkey = new Map([
    [1, 'rk1'],
    [2, 'rk2'],
    [3, 'rk3'],
  ]);

  it('all feeds + all accounts + all types → sourceMode all', () => {
    const result = migrateLegacyView({}, allSubRkeys, allDids);
    expect(result.sourceMode).toBe('all');
    expect(result.sourceKeys).toEqual([]);
  });

  it('no feeds + no accounts → include with empty keys', () => {
    const result = migrateLegacyView(
      { showArticles: false, showDocuments: false },
      allSubRkeys,
      allDids
    );
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toEqual([]);
  });

  it('include specific feeds', () => {
    const result = migrateLegacyView(
      { feedMode: 'include', feedIds: [1, 3], showDocuments: false },
      allSubRkeys,
      allDids,
      idToRkey
    );
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toEqual(['rss~rk1', 'rss~rk3']);
  });

  it('exclude specific feeds', () => {
    const result = migrateLegacyView(
      { feedMode: 'exclude', feedIds: [2], showDocuments: false },
      allSubRkeys,
      allDids,
      idToRkey
    );
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toEqual(['rss~rk1', 'rss~rk3']);
  });

  it('all feeds + include specific accounts with documents', () => {
    const result = migrateLegacyView(
      { accountMode: 'include', accountDids: ['did:plc:a'] },
      allSubRkeys,
      allDids
    );
    expect(result.sourceMode).toBe('include');
    expect(result.sourceKeys).toContain('rss~rk1');
    expect(result.sourceKeys).toContain('rss~rk2');
    expect(result.sourceKeys).toContain('rss~rk3');
    expect(result.sourceKeys).toContain('did:plc:a~documents');
    expect(result.sourceKeys).not.toContain('did:plc:b~documents');
  });
});
