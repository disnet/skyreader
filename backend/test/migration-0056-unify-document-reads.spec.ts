import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

// Migration 0056 unifies document read state from social_read_positions_cache
// (the old source of truth) onto item_labels_cache. Its subtle, irreversible
// part is drift-correction: it DELETEs all existing document reads from
// item_labels_cache BEFORE re-copying the current source, because the 0037
// snapshot drifted — a document read before 0037 and un-read after it survived
// here as a stale live row that the new annotation path would resurrect as read.
// This test exercises that drift case end-to-end against the real migration SQL.

// Load the real migration so the test tracks the shipped SQL, not a copy.
const MIGRATION_0056 = Object.values(
  import.meta.glob('../migrations/0056_unify_document_read_state.sql', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>
)[0];

const TEST_DID = 'did:plc:migration0056';

// Apply the migration the same way test/setup.ts does: strip comments, split on
// `;`, run each statement. (setup.ts already ran 0056 once at startup against an
// empty DB — a no-op — so re-running it here over seeded data is exactly the
// drift scenario the migration is meant to handle.)
async function runMigration0056() {
  const statements = MIGRATION_0056.replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await env.DB.batch(statements.map((stmt) => env.DB.prepare(stmt)));
}

async function seedSourceRead(opts: {
  rkey: string;
  itemUri: string;
  authorDid: string;
  itemUrl: string;
  itemTitle: string;
  readAt: string;
}) {
  await env.DB.prepare(
    `INSERT INTO social_read_positions_cache
       (user_did, rkey, item_type, item_uri, author_did, item_url, item_title, read_at, created_at)
     VALUES (?, ?, 'document', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_DID,
      opts.rkey,
      opts.itemUri,
      opts.authorDid,
      opts.itemUrl,
      opts.itemTitle,
      opts.readAt,
      1_700_000_000
    )
    .run();
}

async function seedLabel(opts: {
  itemKey: string;
  itemType: string;
  label: string;
  deletedAt?: number;
}) {
  await env.DB.prepare(
    `INSERT INTO item_labels_cache
       (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, '{"readAt":"stale"}', 'stale-rk', ?, ?, ?)`
  )
    .bind(TEST_DID, opts.itemKey, opts.itemType, opts.label, 1, 1, opts.deletedAt ?? null)
    .run();
}

describe('migration 0056 (unify document read state)', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM item_labels_cache').run();
    await env.DB.prepare('DELETE FROM social_read_positions_cache').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, tier, created_at)
       VALUES (?, 'mig.bsky.social', 'https://test.pds.example', 'free', unixepoch())`
    )
      .bind(TEST_DID)
      .run();
  });

  it('drops a drifted stale document read so it cannot resurrect as read', async () => {
    // The drift: a live (deleted_at IS NULL) document read in item_labels_cache
    // whose item is NOT in the current source (un-read after the 0037 snapshot).
    await seedLabel({ itemKey: 'at://drifted', itemType: 'document', label: 'read' });

    await runMigration0056();

    const row = await env.DB.prepare(
      `SELECT id FROM item_labels_cache WHERE user_did = ? AND item_key = 'at://drifted' AND label = 'read'`
    )
      .bind(TEST_DID)
      .first();
    // Deleted by the migration's DELETE, and not re-inserted (absent from source).
    expect(row).toBeNull();
  });

  it('copies the current source read with props carried verbatim', async () => {
    await seedSourceRead({
      rkey: 'rk-live',
      itemUri: 'at://did:plc:author/app/doc1',
      authorDid: 'did:plc:author',
      itemUrl: 'https://example.com/doc1',
      itemTitle: 'Doc One',
      readAt: '2026-01-02T03:04:05.000Z',
    });

    await runMigration0056();

    const row = await env.DB.prepare(
      `SELECT item_type, label, props, rkey, deleted_at FROM item_labels_cache
       WHERE user_did = ? AND item_key = 'at://did:plc:author/app/doc1'`
    )
      .bind(TEST_DID)
      .first<{
        item_type: string;
        label: string;
        props: string;
        rkey: string;
        deleted_at: number | null;
      }>();

    expect(row).not.toBeNull();
    expect(row?.item_type).toBe('document');
    expect(row?.label).toBe('read');
    expect(row?.rkey).toBe('rk-live');
    // A copied source read is live, not tombstoned.
    expect(row?.deleted_at).toBeNull();

    const props = JSON.parse(row!.props);
    expect(props).toMatchObject({
      readAt: '2026-01-02T03:04:05.000Z',
      rkey: 'rk-live',
      authorDid: 'did:plc:author',
      itemUrl: 'https://example.com/doc1',
      itemTitle: 'Doc One',
    });
  });

  it('replaces a drifted row when the same item is still in the source', async () => {
    // Same item present as BOTH a stale item_labels row and a live source row.
    // The DELETE+copy must leave the source version (correct props), not the
    // stale one — proving the migration is authoritative-copy, not additive.
    await seedLabel({ itemKey: 'at://overlap', itemType: 'document', label: 'read' });
    await seedSourceRead({
      rkey: 'rk-fresh',
      itemUri: 'at://overlap',
      authorDid: 'did:plc:author',
      itemUrl: 'https://example.com/overlap',
      itemTitle: 'Fresh Title',
      readAt: '2026-02-02T00:00:00.000Z',
    });

    await runMigration0056();

    const row = await env.DB.prepare(
      `SELECT props, rkey FROM item_labels_cache WHERE user_did = ? AND item_key = 'at://overlap'`
    )
      .bind(TEST_DID)
      .first<{ props: string; rkey: string }>();
    expect(row?.rkey).toBe('rk-fresh');
    expect(JSON.parse(row!.props).itemTitle).toBe('Fresh Title');
  });

  it('leaves article reads and non-read document labels untouched', async () => {
    await seedLabel({ itemKey: 'article-1', itemType: 'article', label: 'read' });
    await seedLabel({ itemKey: 'at://doc', itemType: 'document', label: 'archived' });

    await runMigration0056();

    const article = await env.DB.prepare(
      `SELECT id FROM item_labels_cache WHERE user_did = ? AND item_key = 'article-1' AND label = 'read'`
    )
      .bind(TEST_DID)
      .first();
    const archivedDoc = await env.DB.prepare(
      `SELECT id FROM item_labels_cache WHERE user_did = ? AND item_key = 'at://doc' AND label = 'archived'`
    )
      .bind(TEST_DID)
      .first();
    expect(article).not.toBeNull();
    expect(archivedDoc).not.toBeNull();
  });
});
