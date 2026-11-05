import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { createAppPassword } from '../src/services/app-passwords';
import { SYNC_OVERLAP_SECONDS } from '../src/routes/highlight-sync';
import type { ExportSource } from '../src/services/export/render';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

let userSeq = 0;

async function createUser(tier: 'free' | 'supporter' = 'supporter') {
  userSeq++;
  const did = `did:plc:hlsync${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(did, `${did}.test`, 'https://test.pds.example', tier)
    .run();
  const password = (await createAppPassword(env, did, 'Obsidian'))!.password;
  return { did, password };
}

type User = Awaited<ReturnType<typeof createUser>>;

async function save(user: User, rkey: string, title: string, itemGuid?: string) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, saved_at, source, item_guid)
     VALUES (?, ?, ?, ?, ?, 1000, ?, ?)`
  )
    .bind(
      user.did,
      rkey,
      `at://${user.did}/app.skyreader.feed.saved/${rkey}`,
      `https://blog.example/${rkey}`,
      title,
      itemGuid ? 'feed' : 'url',
      itemGuid ?? null
    )
    .run();
}

let labelSeq = 0;
async function highlights(
  user: User,
  itemKey: string,
  list: { id: string; exact: string; note?: string }[],
  updatedAt: number,
  deletedAt: number | null = null
) {
  labelSeq++;
  await env.DB.prepare(
    `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at, deleted_at)
     VALUES (?, ?, 'article', 'highlights', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_did, item_key, label) DO UPDATE SET
       props = excluded.props, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`
  )
    .bind(
      user.did,
      itemKey,
      JSON.stringify({
        highlights: list.map((h, i) => ({
          id: h.id,
          selector: { type: 'TextQuoteSelector', exact: h.exact },
          createdAt: 10 + i,
          ...(h.note ? { note: h.note } : {}),
        })),
      }),
      `hs${labelSeq}`,
      updatedAt,
      updatedAt,
      updatedAt * 1000,
      deletedAt
    )
    .run();
}

async function sync(
  auth: string | null,
  since?: number | string,
  path = '',
  collections: string[] = []
) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { 'CF-Connecting-IP': `10.0.0.${userSeq}` };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const response = await worker.fetch(
    new IncomingRequest(
      `http://localhost/api/highlights/sync${path}?${new URLSearchParams([
        ...(since !== undefined ? [['since', String(since)]] : []),
        ...collections.map((c) => ['collection', c]),
      ])}`,
      { headers }
    ),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function syncOk(user: User, since?: number, collections: string[] = []) {
  const response = await sync(user.password, since, '', collections);
  expect(response.status).toBe(200);
  return (await response.json()) as { cursor: number; sources: ExportSource[] };
}

describe('GET /api/highlights/sync', () => {
  it('needs an app password, and a plan with live integrations', async () => {
    expect((await sync(null)).status).toBe(401);
    expect((await sync('aaaa-bbbb-cccc-dddd-eeee')).status).toBe(401);
    const free = await createUser('free');
    const refused = await sync(free.password);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'upgrade_required' });
    const user = await createUser();
    expect((await sync(user.password, 'yesterday')).status).toBe(400);
  });

  it('sends highlighted pages with stable ids, and leaves unhighlighted saves out', async () => {
    const user = await createUser();
    await save(user, '3mwhuiodre72s', 'Feed post', 'guid-1');
    await save(user, '3mwhuiodre73s', 'Never highlighted');
    await highlights(
      user,
      'guid-1',
      [{ id: 'h1', exact: 'a quote', note: 'my note' }],
      1_700_000_000
    );
    await highlights(
      user,
      'https://elsewhere.example/post',
      [{ id: 'h2', exact: 'unsaved' }],
      1_700_000_050
    );

    const before = Math.floor(Date.now() / 1000);
    const { cursor, sources } = await syncOk(user);
    expect(cursor).toBeGreaterThanOrEqual(before - SYNC_OVERLAP_SECONDS);
    expect(sources.map((s) => [s.id, s.kind, s.title])).toEqual([
      ['saved:3mwhuiodre72s', 'save', 'Feed post'],
      ['https://elsewhere.example/post', 'highlighted', undefined],
    ]);
    expect(sources[0].keys).toEqual([
      'saved:3mwhuiodre72s',
      'guid-1',
      `at://${user.did}/app.skyreader.feed.saved/3mwhuiodre72s`,
    ]);
    expect(sources[0].highlights).toEqual([
      expect.objectContaining({ id: 'h1', text: 'a quote', note: 'my note' }),
    ]);
  });

  it('since a cursor: only changed pages, each whole, and emptied ones', async () => {
    const user = await createUser();
    await save(user, '3mwhuiodre74s', 'Two alias rows', 'guid-2');
    const uri = `at://${user.did}/app.skyreader.feed.saved/3mwhuiodre74s`;
    await highlights(user, uri, [{ id: 'old', exact: 'from the uri row' }], 1_700_000_000);
    await highlights(user, 'guid-2', [{ id: 'new', exact: 'from the guid row' }], 1_700_001_000);
    await highlights(user, 'guid-quiet', [{ id: 'q', exact: 'unchanged' }], 1_700_000_000);
    await highlights(user, 'guid-gone', [{ id: 'g', exact: 'deleted later' }], 1_700_000_000);
    await highlights(user, 'guid-gone', [{ id: 'g', exact: 'deleted later' }], 1_700_001_000, 1);

    const { sources } = await syncOk(user, 1_700_000_500);
    // The save comes back with both alias rows' highlights.
    expect(sources.map((s) => s.id)).toEqual(['saved:3mwhuiodre74s', 'guid-gone']);
    expect(sources[0].highlights.map((h) => h.id).sort()).toEqual(['new', 'old']);
    expect(sources[1]).toMatchObject({ kind: 'highlighted', highlights: [] });
  });

  it('only chosen Shelf collections: every member, highlighted or not, and new members', async () => {
    const user = await createUser();
    await save(user, '3mwhuiodre75s', 'In the collection');
    await save(user, '3mwhuiodre76s', 'Highlighted, in the collection', 'guid-in');
    await save(user, '3mwhuiodre77s', 'Outside it', 'guid-out');
    await highlights(user, 'guid-in', [{ id: 'i', exact: 'inside' }], 1_700_000_000);
    await highlights(user, 'guid-out', [{ id: 'o', exact: 'outside' }], 1_700_000_000);
    await highlights(user, 'https://unsaved.example', [{ id: 'u', exact: 'x' }], 1_700_000_000);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO shelf_collections (user_did, id, name, position, created_at, updated_at)
         VALUES (?, 'thesis', 'Thesis', 1, 1, 1), (?, 'other', 'Other', 2, 1, 1)`
      ).bind(user.did, user.did),
      env.DB.prepare(
        `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
         VALUES (?, 'thesis', '3mwhuiodre75s', 1, 1_700_002_000),
                (?, 'thesis', '3mwhuiodre76s', 2, 1_700_000_000)`
      ).bind(user.did, user.did),
    ]);

    const collections = await sync(user.password, undefined, '/collections');
    expect(await collections.json()).toEqual({
      collections: [
        { id: 'thesis', name: 'Thesis' },
        { id: 'other', name: 'Other' },
      ],
    });

    const all = await syncOk(user, 0, ['thesis']);
    expect(all.sources.map((s) => [s.title, s.highlights.length])).toEqual([
      ['Highlighted, in the collection', 1],
      ['In the collection', 0],
    ]);
    // Since a cursor: the member added after it, not the one highlighted before.
    const changed = await syncOk(user, 1_700_001_000, ['thesis']);
    expect(changed.sources.map((s) => s.title)).toEqual(['In the collection']);
    expect((await syncOk(user, 0, ['other'])).sources).toEqual([]);
  });

  it('keeps the highlights of a page filed under a save that was since deleted', async () => {
    const user = await createUser();
    await highlights(user, 'saved:3mwhuiodre79s', [{ id: 'k', exact: 'kept' }], 1_700_001_000);
    const { sources } = await syncOk(user, 1_700_000_500);
    expect(sources).toEqual([
      expect.objectContaining({
        id: 'saved:3mwhuiodre79s',
        highlights: [expect.objectContaining({ text: 'kept' })],
      }),
    ]);
  });

  it("keeps a backed save's highlights on the save, in both scopes", async () => {
    const user = await createUser();
    const collection = `at://${user.did}/network.cosmik.collection/c1`;
    const card = 'at://other/network.cosmik.card/a';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_settings (user_did, backing, last_backing_poll, last_successful_backing_poll)
         VALUES (?, ?, 1, 1)`
      ).bind(user.did, `semble:${collection}`),
      env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, title, saved_at, source)
         VALUES (?, '3mwhuiodre81s', NULL, 'https://a.test/a', 'https://a.test/a', 'Backed A', 5000, 'url')`
      ).bind(user.did),
      env.DB.prepare(
        `INSERT INTO backed_collection_members
           (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri)
         VALUES (?, ?, 'https://a.test/a', 'https://a.test/a', 'semble', ?, ?)`
      ).bind(user.did, collection, card, `${card}-link`),
      env.DB.prepare(
        `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at)
         VALUES (?, 'reading', '3mwhuiodre81s', 1, 1)`
      ).bind(user.did),
    ]);
    await highlights(user, card, [{ id: 'b', exact: 'on the card' }], 1_700_001_000);
    for (const collections of [[], ['reading']]) {
      const { sources } = await syncOk(user, 1_700_000_500, collections);
      expect(sources.map((s) => [s.id, s.kind, s.highlights.length])).toEqual([
        ['saved:3mwhuiodre81s', 'save', 1],
      ]);
    }
  });
});
