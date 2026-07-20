import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase, hashUrl, EXTRACTOR_VERSION } from './app';

// Mirrors the read query in the /extract handler: a cached extraction is only a
// hit when its stored extractor_version matches the current one.
function readFresh(db: Database, urlHash: string) {
  return db
    .query<
      { extracted_json: string; cached_at: number },
      [string, number]
    >('SELECT extracted_json, cached_at FROM extract_cache WHERE url_hash = ? AND extractor_version = ?')
    .get(urlHash, EXTRACTOR_VERSION);
}

function insert(db: Database, url: string, version: number) {
  db.run(
    'INSERT OR REPLACE INTO extract_cache (url_hash, url, extracted_json, cached_at, extractor_version) VALUES (?, ?, ?, ?, ?)',
    [hashUrl(url), url, JSON.stringify({ content: 'x' }), Date.now(), version]
  );
}

describe('extract_cache extractor_version', () => {
  it('treats a stale-version row as a miss', () => {
    const db = new Database(':memory:');
    initDatabase(db);
    const url = 'https://example.com/a';
    insert(db, url, EXTRACTOR_VERSION - 1);
    expect(readFresh(db, hashUrl(url))).toBeNull();
  });

  it('serves a current-version row as a hit', () => {
    const db = new Database(':memory:');
    initDatabase(db);
    const url = 'https://example.com/b';
    insert(db, url, EXTRACTOR_VERSION);
    expect(readFresh(db, hashUrl(url))).not.toBeNull();
  });

  it('re-extraction overwrites the stale row rather than duplicating it', () => {
    const db = new Database(':memory:');
    initDatabase(db);
    const url = 'https://example.com/c';
    insert(db, url, EXTRACTOR_VERSION - 1); // old extractor wrote this
    insert(db, url, EXTRACTOR_VERSION); // re-extraction after a version bump
    const rows = db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM extract_cache WHERE url_hash = ?')
      .get(hashUrl(url));
    expect(rows?.n).toBe(1);
    expect(readFresh(db, hashUrl(url))).not.toBeNull();
  });

  it('backfills the column on a legacy cache and defaults old rows to a miss', () => {
    const db = new Database(':memory:');
    // Legacy table shape: no extractor_version column.
    db.run(`
      CREATE TABLE extract_cache (
        url_hash TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        extracted_json TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      )
    `);
    const url = 'https://example.com/legacy';
    db.run(
      'INSERT INTO extract_cache (url_hash, url, extracted_json, cached_at) VALUES (?, ?, ?, ?)',
      [hashUrl(url), url, JSON.stringify({ content: 'old' }), Date.now()]
    );

    initDatabase(db); // runs the ALTER migration

    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(extract_cache)`).all();
    expect(cols.some((c) => c.name === 'extractor_version')).toBe(true);
    // The pre-existing row defaulted to version 0, so it reads as a miss.
    expect(readFresh(db, hashUrl(url))).toBeNull();
  });
});
