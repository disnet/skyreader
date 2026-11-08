import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { createAppPassword, type AppPasswordScope } from '../src/services/app-passwords';
import { SYNC_OVERLAP_SECONDS } from '../src/routes/highlight-sync';
import type { ExportSource } from '../src/services/export/render';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

let userSeq = 0;

async function createUser(
  tier: 'free' | 'supporter' = 'supporter',
  scope: AppPasswordScope = 'highlights'
) {
  userSeq++;
  const did = `did:plc:hlsync${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(did, `${did}.test`, 'https://test.pds.example', tier)
    .run();
  const password = (await createAppPassword(env, did, 'Obsidian', scope))!.password;
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

describe('scratch', () => {
  it('deleted url-linked row', async () => {
    const user = await createUser();
    await save(user, '3mwhuiodre99s', 'Saved page');
    await highlights(user, 'saved:3mwhuiodre99s', [{ id: 'h1', exact: 'own' }], 1_700_000_000);
    await highlights(user, 'https://blog.example/3mwhuiodre99s', [{ id: 'h2', exact: 'by url' }], 1_700_000_000);
    const first = await syncOk(user, 0);
    console.log('FIRST', JSON.stringify(first.sources.map((s) => [s.id, s.keys, s.highlights.map((h) => h.id)])));
    await highlights(user, 'https://blog.example/3mwhuiodre99s', [{ id: 'h2', exact: 'by url' }], 1_700_001_000, 1_700_001_000);
    const second = await syncOk(user, 1_700_000_500);
    console.log('SECOND', JSON.stringify(second.sources.map((s) => [s.kind, s.id, s.keys, s.title, s.highlights.map((h) => h.id)])));
  });
});
