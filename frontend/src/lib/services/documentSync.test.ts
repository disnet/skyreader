import { describe, it, expect, vi } from 'vitest';
import {
  docInScope,
  reconcileDocuments,
  buildDocumentRequests,
  collectDocumentBatches,
  type DocumentScopeResult,
  type DocumentRequest,
} from './documentSync';
import { scopeKey } from './documentDigests';
import type { SocialDocument, Subscription } from '$lib/types';

const AUTHOR = 'did:plc:author';
const PUB_A = 'at://did:plc:author/site.standard.publication/a';
const PUB_B = 'at://did:plc:author/site.standard.publication/b';

function doc(overrides: Partial<SocialDocument>): SocialDocument {
  return {
    authorDid: AUTHOR,
    recordUri: 'at://did:plc:author/site.standard.document/x',
    siteUri: PUB_A,
    title: 'Doc',
    publishedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function ready(
  did: string,
  siteUri: string | undefined,
  documents: SocialDocument[]
): DocumentScopeResult {
  return { did, siteUri, documents, status: 'ready' };
}

describe('docInScope', () => {
  it('matches everything when scope is undefined', () => {
    expect(docInScope(doc({ siteUri: PUB_A }), undefined)).toBe(true);
    expect(docInScope(doc({ siteUri: '' }), undefined)).toBe(true);
  });

  it('matches only the exact publication for an at:// scope', () => {
    expect(docInScope(doc({ siteUri: PUB_A }), PUB_A)).toBe(true);
    expect(docInScope(doc({ siteUri: PUB_B }), PUB_A)).toBe(false);
  });
});

describe('reconcileDocuments', () => {
  it('adds fresh documents to an empty set', () => {
    const fresh = doc({ recordUri: 'doc1' });
    const result = reconcileDocuments([], [ready(AUTHOR, PUB_A, [fresh])]);
    expect(result.map((d) => d.recordUri)).toEqual(['doc1']);
  });

  it('self-heals deletes: drops in-scope docs the proxy no longer returns', () => {
    const current = [
      doc({ recordUri: 'keep', siteUri: PUB_A }),
      doc({ recordUri: 'deleted-upstream', siteUri: PUB_A }),
    ];
    // The fresh set for PUB_A no longer contains 'deleted-upstream'.
    const result = reconcileDocuments(current, [
      ready(AUTHOR, PUB_A, [doc({ recordUri: 'keep', siteUri: PUB_A })]),
    ]);
    expect(result.map((d) => d.recordUri)).toEqual(['keep']);
  });

  it('ignores error results so a failed fetch never drops cached docs', () => {
    const current = [doc({ recordUri: 'cached', siteUri: PUB_A })];
    const result = reconcileDocuments(current, [
      { did: AUTHOR, siteUri: PUB_A, documents: [], status: 'error' },
    ]);
    expect(result.map((d) => d.recordUri)).toEqual(['cached']);
  });

  it('only reconciles within the result scope, leaving other publications intact', () => {
    const current = [
      doc({ recordUri: 'a1', siteUri: PUB_A }),
      doc({ recordUri: 'b1', siteUri: PUB_B }),
    ];
    // A fresh result for PUB_A must not disturb PUB_B's documents.
    const result = reconcileDocuments(current, [
      ready(AUTHOR, PUB_A, [doc({ recordUri: 'a2', siteUri: PUB_A })]),
    ]);
    expect(result.map((d) => d.recordUri).sort()).toEqual(['a2', 'b1']);
  });

  it('does not touch other authors', () => {
    const other = doc({
      authorDid: 'did:plc:other',
      recordUri: 'other1',
      siteUri: PUB_A,
    });
    const result = reconcileDocuments([other], [ready(AUTHOR, undefined, [])]);
    expect(result.map((d) => d.recordUri)).toEqual(['other1']);
  });

  it('an undefined (all) scope replaces every document for that author', () => {
    const current = [
      doc({ recordUri: 'a1', siteUri: PUB_A }),
      doc({ recordUri: 'b1', siteUri: PUB_B }),
      doc({ recordUri: 'free', siteUri: '' }),
    ];
    const result = reconcileDocuments(current, [
      ready(AUTHOR, undefined, [doc({ recordUri: 'only', siteUri: PUB_A })]),
    ]);
    expect(result.map((d) => d.recordUri)).toEqual(['only']);
  });

  it('dedupes overlapping scopes by recordUri (last applied wins)', () => {
    // The same doc appears in an "all" scope and a publication scope; the second
    // application should win and there should be exactly one copy.
    const result = reconcileDocuments(
      [],
      [
        ready(AUTHOR, undefined, [doc({ recordUri: 'dup', title: 'first', siteUri: PUB_A })]),
        ready(AUTHOR, PUB_A, [doc({ recordUri: 'dup', title: 'second', siteUri: PUB_A })]),
      ]
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('second');
  });

  it('returns documents newest-first', () => {
    const result = reconcileDocuments(
      [],
      [
        ready(AUTHOR, PUB_A, [
          doc({ recordUri: 'old', publishedAt: '2024-01-01T00:00:00.000Z' }),
          doc({ recordUri: 'new', publishedAt: '2024-06-01T00:00:00.000Z' }),
          doc({ recordUri: 'mid', publishedAt: '2024-03-01T00:00:00.000Z' }),
        ]),
      ]
    );
    expect(result.map((d) => d.recordUri)).toEqual(['new', 'mid', 'old']);
  });

  it('ignores an unchanged result: keeps the scope intact (never clears it)', () => {
    const current = [doc({ recordUri: 'held', siteUri: PUB_A })];
    // A bodyless `unchanged` result (no documents) must not reach the drop-then-add
    // loop and wipe the scope — the status filter excludes it.
    const result = reconcileDocuments(current, [
      { did: AUTHOR, siteUri: PUB_A, status: 'unchanged' },
    ]);
    expect(result.map((d) => d.recordUri)).toEqual(['held']);
  });
});

describe('buildDocumentRequests', () => {
  function sub(overrides: Partial<Subscription>): Subscription {
    return {
      rkey: 'rk',
      title: 'T',
      tags: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      localUpdatedAt: 0,
      ...overrides,
    };
  }

  it('keeps only atproto.documents subscriptions with a subjectDid', () => {
    const requests = buildDocumentRequests([
      sub({
        sourceType: 'atproto.documents',
        subjectDid: AUTHOR,
        feedUrl: PUB_A,
      }),
      sub({ feedUrl: 'https://example.com/rss.xml' }), // RSS — ignored
      sub({ sourceType: 'atproto.documents' }), // missing subjectDid — ignored
    ]);
    expect(requests).toEqual([{ did: AUTHOR, siteUri: PUB_A }]);
  });

  it('maps an empty feedUrl to an undefined (all-documents) scope', () => {
    const requests = buildDocumentRequests([
      sub({ sourceType: 'atproto.documents', subjectDid: AUTHOR, feedUrl: '' }),
    ]);
    expect(requests).toEqual([{ did: AUTHOR, siteUri: undefined }]);
  });

  it('attaches a stored since_digest per scope, omitting it when absent', () => {
    const digests = { [scopeKey(AUTHOR, PUB_A)]: 'digest-a' };
    const requests = buildDocumentRequests(
      [
        sub({ sourceType: 'atproto.documents', subjectDid: AUTHOR, feedUrl: PUB_A }),
        sub({ sourceType: 'atproto.documents', subjectDid: AUTHOR, feedUrl: PUB_B }),
      ],
      digests
    );
    expect(requests).toEqual([
      { did: AUTHOR, siteUri: PUB_A, since_digest: 'digest-a' },
      // No stored digest for PUB_B → cold start, since_digest omitted.
      { did: AUTHOR, siteUri: PUB_B },
    ]);
  });
});

describe('collectDocumentBatches', () => {
  const req = (n: number): DocumentRequest => ({ did: `did:plc:${n}` });

  it('chunks requests by batchSize and accumulates every batch', async () => {
    const requests = [req(1), req(2), req(3)];
    const seen: DocumentRequest[][] = [];
    const fetchBatch = vi.fn(async (batch: DocumentRequest[]) => {
      seen.push(batch);
      return { authors: batch.map((r) => ({ did: r.did })) };
    });

    const result = await collectDocumentBatches(requests, 2, fetchBatch);

    expect(seen).toEqual([[req(1), req(2)], [req(3)]]);
    expect(result).toEqual([{ did: 'did:plc:1' }, { did: 'did:plc:2' }, { did: 'did:plc:3' }]);
  });

  it('skips a failing batch (logs via onError) without losing the others', async () => {
    const requests = [req(1), req(2), req(3), req(4)];
    const onError = vi.fn();
    const fetchBatch = vi.fn(async (batch: DocumentRequest[]) => {
      if (batch[0].did === 'did:plc:1') throw new Error('boom');
      return { authors: batch.map((r) => ({ did: r.did })) };
    });

    const result = await collectDocumentBatches(requests, 2, fetchBatch, onError);

    // First batch (1,2) threw; second batch (3,4) still contributes.
    expect(result).toEqual([{ did: 'did:plc:3' }, { did: 'did:plc:4' }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array for no requests (no fetch calls)', async () => {
    const fetchBatch = vi.fn();
    const result = await collectDocumentBatches([], 50, fetchBatch);
    expect(result).toEqual([]);
    expect(fetchBatch).not.toHaveBeenCalled();
  });
});
