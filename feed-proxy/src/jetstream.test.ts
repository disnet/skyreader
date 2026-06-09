import { test, expect, describe, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase } from './app';
import { DocumentFirehose } from './jetstream';
import { recordToProxyDocument, type ProxyDocument } from './standard-site';

function makeDb(): Database {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

function seedAuthor(
  db: Database,
  did: string,
  docs: ProxyDocument[],
  lastRequestedAt: number
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO document_cache (did, documents_json, cached_at, fetched_at, last_requested_at)
		 VALUES (?, ?, ?, ?, ?)`,
    [did, JSON.stringify(docs), now, now, lastRequestedAt]
  );
}

function getDocs(db: Database, did: string): ProxyDocument[] {
  const row = db
    .query<
      { documents_json: string },
      [string]
    >('SELECT documents_json FROM document_cache WHERE did = ?')
    .get(did);
  return row ? (JSON.parse(row.documents_json) as ProxyDocument[]) : [];
}

// A `site.standard.document` commit event. Loose https:// `site` keeps
// resolveSiteMeta network-free (it returns the URL as its own base).
function event(
  did: string,
  rkey: string,
  operation: 'create' | 'update' | 'delete',
  record?: Record<string, unknown>
) {
  return {
    did,
    time_us: 1_700_000_000_000_000,
    kind: 'commit' as const,
    commit: {
      operation,
      collection: 'site.standard.document',
      rkey,
      cid: `cid-${rkey}`,
      record,
    },
  };
}

const DID = 'did:plc:alice';

describe('recordToProxyDocument', () => {
  test('maps a record to canonical URL + links + cover CID', async () => {
    const db = makeDb();
    const doc = await recordToProxyDocument(
      db,
      DID,
      `at://${DID}/site.standard.document/abc`,
      'cid-abc',
      {
        site: 'https://alice.example',
        title: 'Hello',
        path: '/posts/hello',
        publishedAt: '2026-01-01T00:00:00.000Z',
        coverImage: { ref: { $link: 'blobcid123' } },
        links: [{ uri: 'https://news.example/story', rel: 'about' }, { uri: '' }],
      }
    );

    expect(doc.recordUri).toBe(`at://${DID}/site.standard.document/abc`);
    expect(doc.title).toBe('Hello');
    expect(doc.canonicalUrl).toBe('https://alice.example/posts/hello');
    expect(doc.coverImageCid).toBe('blobcid123');
    expect(doc.links).toEqual([{ uri: 'https://news.example/story', rel: 'about' }]);
  });
});

describe('DocumentFirehose.applyDocumentEvent', () => {
  let db: Database;
  let firehose: DocumentFirehose;

  beforeEach(() => {
    db = makeDb();
    firehose = new DocumentFirehose(db, { enabled: false });
  });

  test('create inserts and keeps the list newest-first', async () => {
    seedAuthor(
      db,
      DID,
      [
        { recordUri: 'at://x/c/old', publishedAt: '2026-01-01T00:00:00.000Z' } as ProxyDocument,
        { recordUri: 'at://x/c/new', publishedAt: '2026-03-01T00:00:00.000Z' } as ProxyDocument,
      ],
      Date.now()
    );

    await firehose.applyDocumentEvent(
      event(DID, 'mid', 'create', {
        site: 'https://alice.example',
        title: 'Middle',
        publishedAt: '2026-02-01T00:00:00.000Z',
      })
    );

    const docs = getDocs(db, DID);
    expect(docs.map((d) => d.recordUri)).toEqual([
      'at://x/c/new',
      `at://${DID}/site.standard.document/mid`,
      'at://x/c/old',
    ]);
  });

  test('update replaces the existing record by uri (no duplicate)', async () => {
    const uri = `at://${DID}/site.standard.document/p1`;
    seedAuthor(
      db,
      DID,
      [{ recordUri: uri, title: 'Old', publishedAt: '2026-01-01T00:00:00.000Z' } as ProxyDocument],
      Date.now()
    );

    await firehose.applyDocumentEvent(
      event(DID, 'p1', 'update', {
        site: 'https://alice.example',
        title: 'Edited',
        publishedAt: '2026-01-01T00:00:00.000Z',
      })
    );

    const docs = getDocs(db, DID);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Edited');
  });

  test('delete removes the record', async () => {
    const uri = `at://${DID}/site.standard.document/p1`;
    seedAuthor(
      db,
      DID,
      [
        { recordUri: uri, publishedAt: '2026-01-01T00:00:00.000Z' } as ProxyDocument,
        { recordUri: 'at://x/c/keep', publishedAt: '2026-02-01T00:00:00.000Z' } as ProxyDocument,
      ],
      Date.now()
    );

    await firehose.applyDocumentEvent(event(DID, 'p1', 'delete'));

    const docs = getDocs(db, DID);
    expect(docs.map((d) => d.recordUri)).toEqual(['at://x/c/keep']);
  });

  test('skips authors with no cache row (no synthesized history)', async () => {
    await firehose.applyDocumentEvent(
      event(DID, 'x', 'create', {
        site: 'https://alice.example',
        publishedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const row = db.query('SELECT * FROM document_cache WHERE did = ?').get(DID);
    expect(row).toBeNull();
  });

  test('trims to MAX_DOCUMENTS_PER_AUTHOR (100), keeping the newest', async () => {
    const seed: ProxyDocument[] = Array.from({ length: 100 }, (_, i) => ({
      recordUri: `at://x/c/${i}`,
      // Oldest first by date; index 0 is the oldest.
      publishedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    })) as ProxyDocument[];
    seedAuthor(db, DID, seed, Date.now());

    // A brand-new doc dated after all 100 → should push out the oldest.
    await firehose.applyDocumentEvent(
      event(DID, 'newest', 'create', {
        site: 'https://alice.example',
        publishedAt: new Date(Date.UTC(2026, 6, 1)).toISOString(),
      })
    );

    const docs = getDocs(db, DID);
    expect(docs).toHaveLength(100);
    expect(docs[0].recordUri).toBe(`at://${DID}/site.standard.document/newest`);
    // The oldest seed (index 0) was trimmed.
    expect(docs.some((d) => d.recordUri === 'at://x/c/0')).toBe(false);
  });
});

describe('DocumentFirehose reconcile / active-author set', () => {
  test('only watches authors requested within the active window', () => {
    const db = makeDb();
    const now = Date.now();
    const fh = new DocumentFirehose(db, { enabled: false, activeWindowMs: 1000 });

    seedAuthor(db, 'did:plc:fresh', [], now); // within window
    seedAuthor(db, 'did:plc:stale', [], now - 10_000); // outside window

    fh.reconcile(); // not running → updates the set without connecting

    expect(fh.isSubscribed('did:plc:fresh')).toBe(true);
    expect(fh.isSubscribed('did:plc:stale')).toBe(false);
  });

  test('caps the watched set at 10,000 most-recently-requested DIDs', () => {
    const db = makeDb();
    const now = Date.now();
    const fh = new DocumentFirehose(db, { enabled: false });

    const insert = db.prepare(
      'INSERT INTO document_cache (did, documents_json, cached_at, fetched_at, last_requested_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMany = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(`did:plc:u${i}`, '[]', now, now, now - i);
    });
    insertMany(10_001);

    expect(fh.computeActiveDids(now)).toHaveLength(10_000);
  });
});

describe('DocumentFirehose.isHealthy', () => {
  // A subscription filtered to our DIDs + one collection can be legitimately
  // silent for minutes, so liveness rides on frame activity (our ping → pong),
  // not on whether documents are flowing. An open-but-stale socket is unhealthy.
  test('healthy only while connected AND a frame arrived recently', () => {
    const db = makeDb();
    const fh = new DocumentFirehose(db, { enabled: true });
    const internals = fh as unknown as { connected: boolean; lastActivityAt: number };

    // Not connected → unhealthy regardless of activity.
    internals.connected = false;
    internals.lastActivityAt = Date.now();
    expect(fh.isHealthy()).toBe(false);

    // Connected with a recent frame → healthy.
    internals.connected = true;
    internals.lastActivityAt = Date.now();
    expect(fh.isHealthy()).toBe(true);

    // Connected but no frame for >90s (stalled/half-open) → unhealthy.
    internals.lastActivityAt = Date.now() - 91_000;
    expect(fh.isHealthy()).toBe(false);
  });

  test('disabled is never healthy', () => {
    const db = makeDb();
    const fh = new DocumentFirehose(db, { enabled: false });
    const internals = fh as unknown as { connected: boolean; lastActivityAt: number };
    internals.connected = true;
    internals.lastActivityAt = Date.now();
    expect(fh.isHealthy()).toBe(false);
  });
});
