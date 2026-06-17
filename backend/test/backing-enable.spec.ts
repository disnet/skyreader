import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enableBacking,
  disableBacking,
  uniqueCollectionName,
  countExportableSaves,
  exportNativeSaves,
} from '../src/services/backing/enable';
import type { SaveBacking } from '../src/routes/settings';
import type { Session } from '../src/types';
import * as write from '../src/services/backing/write';
import * as read from '../src/services/backing/read';
import * as sync from '../src/services/backing/sync';

const DID = 'did:plc:enabletest';
const COLLECTION = `at://${DID}/network.cosmik.collection/col1`;
const fakeSession = { did: DID, pdsUrl: 'https://pds.test' } as unknown as Session;

async function reset() {
  for (const t of [
    'saved_articles',
    'backed_collection_members',
    'backed_unsave_tombstones',
    'user_settings',
  ]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE user_did = ?`).bind(DID).run();
  }
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, last_synced_at) VALUES (?, 'enable.test', 'https://pds.test', 0)
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(DID)
    .run();
}

// Empty, complete snapshot so the backfill poll inside enableBacking is a clean no-op.
function mockEmptySnapshot() {
  vi.spyOn(read, 'snapshotBackedCollection').mockResolvedValue({
    complete: true,
    members: [],
    skipped: [],
    typeMix: {},
  });
}
function mockCreateMember() {
  let n = 0;
  return vi.spyOn(write, 'createMember').mockImplementation(async () => {
    n++;
    return {
      itemUri: `at://${DID}/network.cosmik.card/c${n}`,
      linkUri: `at://${DID}/network.cosmik.collectionLink/l${n}`,
    };
  });
}

async function backingOf(): Promise<string | null> {
  const row = await env.DB.prepare('SELECT backing FROM user_settings WHERE user_did = ?')
    .bind(DID)
    .first<{ backing: string | null }>();
  return row?.backing ?? null;
}

describe('enableBacking', () => {
  beforeEach(reset);

  it('reuses a given collection and writes the backing setting', async () => {
    mockEmptySnapshot();
    const createCol = vi.spyOn(write, 'createCollection');
    const result = await enableBacking(env, fakeSession, {
      provider: 'semble',
      collectionUri: COLLECTION,
    });
    expect(createCol).not.toHaveBeenCalled(); // reused, not created
    expect(result.backing).toEqual({ provider: 'semble', collectionUri: COLLECTION });
    expect(await backingOf()).toBe(`semble:${COLLECTION}`);
  });

  it('creates a default "Skyreader Saves" collection when none is given', async () => {
    mockEmptySnapshot();
    const createCol = vi.spyOn(write, 'createCollection').mockResolvedValue({ uri: COLLECTION });
    const result = await enableBacking(env, fakeSession, { provider: 'semble' });
    expect(createCol).toHaveBeenCalledWith(expect.anything(), 'semble', 'Skyreader Saves');
    expect(result.backing).toEqual({ provider: 'semble', collectionUri: COLLECTION });
  });

  it('exports existing native saves into the collection (idempotent by URL)', async () => {
    mockEmptySnapshot();
    const createMember = mockCreateMember();
    // two distinct native saves + a duplicate-URL row that must not double-export
    for (const [rkey, url] of [
      ['rk1', 'https://a.test/x'],
      ['rk2', 'https://b.test/y'],
      ['rk3', 'https://a.test/x'],
    ]) {
      await env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, url, title, source, saved_at, created_at)
         VALUES (?, ?, ?, 'T', 'url', 100, 100)`
      )
        .bind(DID, rkey, url)
        .run();
    }

    const result = await enableBacking(env, fakeSession, {
      provider: 'semble',
      collectionUri: COLLECTION,
      exportExisting: true,
    });

    expect(result.exported).toBe(2); // a.test/x and b.test/y, dup collapsed
    expect(createMember).toHaveBeenCalledTimes(2);
    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(2);
  });

  it('does not re-export a save already in the collection', async () => {
    // A non-empty snapshot makes enableBacking eagerly extract the imported stub's body
    // via the feed proxy; stub it out so the test doesn't hit a (nonexistent) network.
    vi.spyOn(sync, 'extractMissingBackedContent').mockResolvedValue(0);
    // snapshot already contains a.test/x, so the backfill poll seeds membership for it
    vi.spyOn(read, 'snapshotBackedCollection').mockResolvedValue({
      complete: true,
      members: [
        {
          url: 'https://a.test/x',
          urlNormalized: 'https://a.test/x',
          itemUri: 'at://x/card/1',
          linkUri: 'at://x/link/1',
          itemType: 'network.cosmik.card',
        },
      ],
      skipped: [],
      typeMix: {},
    });
    const createMember = mockCreateMember();
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, source, saved_at, created_at)
       VALUES (?, 'rk1', 'https://a.test/x', 'url', 100, 100)`
    )
      .bind(DID)
      .run();

    const result = await enableBacking(env, fakeSession, {
      provider: 'semble',
      collectionUri: COLLECTION,
      exportExisting: true,
    });
    expect(result.exported).toBe(0);
    expect(createMember).not.toHaveBeenCalled();

    // The legacy save and the collection member must collapse to ONE enrichment row
    // (backfill keyed the legacy row before the poll, so the stub upsert conflicts
    // onto it instead of creating a duplicate).
    const saved = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(saved?.n).toBe(1);
    const keyed = await env.DB.prepare(
      'SELECT url_normalized FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ url_normalized: string | null }>();
    expect(keyed?.url_normalized).toBe('https://a.test/x'); // legacy row got keyed
  });

  it('backfillUrlNormalized keys legacy saves and is collision-safe', async () => {
    mockEmptySnapshot();
    // Two rows normalizing to the same key (tracking param) + a distinct one.
    for (const [rkey, url] of [
      ['rk1', 'https://a.test/x?utm_source=news'],
      ['rk2', 'https://a.test/x'],
      ['rk3', 'https://b.test/y'],
    ]) {
      await env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, url, source, saved_at, created_at)
         VALUES (?, ?, ?, 'url', 100, 100)`
      )
        .bind(DID, rkey, url)
        .run();
    }

    await enableBacking(env, fakeSession, { provider: 'semble', collectionUri: COLLECTION });

    // Exactly one of the two colliding rows gets the shared key; the other stays NULL
    // (a pre-existing native dup). The distinct row is keyed too. No INSERT failure.
    const keyed = await env.DB.prepare(
      `SELECT url_normalized FROM saved_articles WHERE user_did = ? AND url_normalized IS NOT NULL ORDER BY url_normalized`
    )
      .bind(DID)
      .all<{ url_normalized: string }>();
    expect(keyed.results.map((r) => r.url_normalized)).toEqual([
      'https://a.test/x',
      'https://b.test/y',
    ]);
  });
});

describe('uniqueCollectionName', () => {
  it('returns the base name when it is free', () => {
    expect(uniqueCollectionName('Skyreader Saves', ['Reading', 'Later'])).toBe('Skyreader Saves');
  });

  it('suffixes " 2", " 3", … past case-insensitive collisions', () => {
    expect(uniqueCollectionName('Skyreader Saves', ['skyreader saves'])).toBe('Skyreader Saves 2');
    expect(uniqueCollectionName('Skyreader Saves', ['Skyreader Saves', 'Skyreader Saves 2'])).toBe(
      'Skyreader Saves 3'
    );
  });
});

describe('countExportableSaves', () => {
  beforeEach(reset);

  it('counts only saves with a real URL (excludes empty/null url)', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, source, saved_at, created_at) VALUES
         (?, 'rk1', 'https://a.test/x', 'url', 100, 100),
         (?, 'rk2', 'https://b.test/y', 'feed', 100, 100),
         (?, 'rk3', '', 'share', 100, 100)`
    )
      .bind(DID, DID, DID)
      .run();
    expect(await countExportableSaves(env, DID)).toBe(2);
  });
});

describe('exportNativeSaves — batched cursor', () => {
  beforeEach(reset);

  const backing: Extract<SaveBacking, { provider: 'semble' | 'margin' }> = {
    provider: 'semble',
    collectionUri: COLLECTION,
  };

  async function seedSaves(urls: string[]) {
    for (let i = 0; i < urls.length; i++) {
      await env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, url, source, saved_at, created_at)
         VALUES (?, ?, ?, 'url', 100, 100)`
      )
        .bind(DID, `rk${i}`, urls[i])
        .run();
    }
  }

  it('advances by `scanned` (rows examined), exporting one stable slice per call', async () => {
    mockCreateMember();
    await seedSaves(['https://a.test/1', 'https://b.test/2', 'https://c.test/3']);

    const first = await exportNativeSaves(env, fakeSession, backing, { offset: 0, limit: 2 });
    expect(first).toEqual({ exported: 2, scanned: 2 });
    const second = await exportNativeSaves(env, fakeSession, backing, { offset: 2, limit: 2 });
    expect(second).toEqual({ exported: 1, scanned: 1 }); // last partial slice

    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(3);
  });

  it('an already-backed row in the slice is scanned but not re-exported (cursor still advances)', async () => {
    mockCreateMember();
    await seedSaves(['https://a.test/1', 'https://b.test/2']);
    // Pre-mark the first save as already a member.
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri)
       VALUES (?, ?, 'https://a.test/1', 'https://a.test/1', 'semble', 'at://card/0', 'at://link/0')`
    )
      .bind(DID, COLLECTION)
      .run();

    const res = await exportNativeSaves(env, fakeSession, backing, { offset: 0, limit: 2 });
    expect(res.scanned).toBe(2); // both examined → cursor moves past the backed one
    expect(res.exported).toBe(1); // only b.test/2 newly exported
  });

  it('is best-effort: one createMember failure does not abort the rest of the slice', async () => {
    let n = 0;
    vi.spyOn(write, 'createMember').mockImplementation(async () => {
      n++;
      if (n === 1) throw new Error('transient PDS error');
      return {
        itemUri: `at://${DID}/network.cosmik.card/c${n}`,
        linkUri: `at://${DID}/network.cosmik.collectionLink/l${n}`,
      };
    });
    await seedSaves(['https://a.test/1', 'https://b.test/2']);

    const res = await exportNativeSaves(env, fakeSession, backing, {});
    expect(res.scanned).toBe(2);
    expect(res.exported).toBe(1); // first failed, second succeeded
  });
});

describe('disableBacking', () => {
  beforeEach(reset);

  it('reverts to skyreader and clears the local snapshot, leaving enrichment rows', async () => {
    await env.DB.prepare(`INSERT INTO user_settings (user_did, backing) VALUES (?, ?)`)
      .bind(DID, `semble:${COLLECTION}`)
      .run();
    await env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
       VALUES (?, ?, 'https://a.test/x', 'https://a.test/x', 'semble', 'at://card/1', 'at://link/1', NULL)`
    )
      .bind(DID, COLLECTION)
      .run();
    await env.DB.prepare(
      `INSERT INTO saved_articles (user_did, rkey, url, url_normalized, source, saved_at, created_at)
       VALUES (?, 'rk1', 'https://a.test/x', 'https://a.test/x', 'url', 100, 100)`
    )
      .bind(DID)
      .run();

    await disableBacking(env, fakeSession);

    expect(await backingOf()).toBe('skyreader');
    const mem = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM backed_collection_members WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(mem?.n).toBe(0); // membership snapshot cleared
    const saved = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM saved_articles WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ n: number }>();
    expect(saved?.n).toBe(1); // enrichment rows preserved (canonical saves)
  });
});
