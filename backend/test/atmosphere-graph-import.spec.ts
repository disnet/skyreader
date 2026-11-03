import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyGraphEdgeCreate,
  applyGraphEdgeDelete,
  enqueueDueGraphScans,
  scanGraphFollows,
} from '../src/services/atmosphere-graph-import';
import type { Env } from '../src/types';

const READER = 'did:plc:graphreader';
const AUTHOR = 'did:plc:graphauthor';
const PUB = `at://${AUTHOR}/site.standard.publication/blog`;
const PUB2 = `at://${AUTHOR}/site.standard.publication/other`;
const OFF = { syncEnabled: false };
const ON = { syncEnabled: true };

/** The reader's graph as their PDS lists it. */
let graph: Array<{ rkey: string; publication: string }> = [];

function mockNetwork(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('plc.directory')) {
      const did = decodeURIComponent(url.split('/').pop() ?? '');
      return new Response(
        JSON.stringify({
          id: did,
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.example',
            },
          ],
        })
      );
    }
    if (url.includes('com.atproto.repo.getRecord')) {
      return new Response(JSON.stringify({ value: { name: 'A Blog', url: 'https://a.blog' } }));
    }
    if (url.includes('com.atproto.repo.listRecords')) {
      return new Response(
        JSON.stringify({
          records: graph.map((r) => ({
            uri: `at://${READER}/site.standard.graph.subscription/${r.rkey}`,
            value: { publication: r.publication },
          })),
        })
      );
    }
    return new Response('{}', { status: 404 });
  });
}

async function subs() {
  const rows = await env.DB.prepare(
    `SELECT record_uri, feed_url, title, active, atmosphere_synced, pds_dirty
       FROM subscriptions_cache WHERE user_did = ? ORDER BY feed_url`
  )
    .bind(READER)
    .all<{
      record_uri: string;
      feed_url: string;
      title: string;
      active: number;
      atmosphere_synced: number | null;
      pds_dirty: number;
    }>();
  return rows.results ?? [];
}

async function followHere(pub: string): Promise<string> {
  const recordUri = `at://${READER}/app.skyreader.feed.subscription/3kinapp000000`;
  await env.DB.prepare(
    `INSERT INTO subscriptions_cache (user_did, record_uri, feed_url, title, created_at, source_type, subject_did)
     VALUES (?, ?, ?, 'Mine', unixepoch(), 'atproto.documents', ?)`
  )
    .bind(READER, recordUri, pub, AUTHOR)
    .run();
  return recordUri;
}

describe('importing standard.site follows made elsewhere', () => {
  beforeEach(async () => {
    graph = [];
    mockNetwork();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM subscriptions_cache'),
      env.DB.prepare('DELETE FROM atmosphere_graph_edges'),
      env.DB.prepare('DELETE FROM atmosphere_graph_scans'),
      env.DB.prepare('DELETE FROM users'),
      env.DB.prepare(
        `INSERT INTO users (did, handle, pds_url) VALUES (?, 'reader.test', 'https://pds.example')`
      ).bind(READER),
    ]);
  });

  it('imports a new follow as a subscription, with sync off', async () => {
    expect(await applyGraphEdgeCreate(env, READER, 'leaflet1', PUB, OFF)).toBe('imported');
    const [sub] = await subs();
    expect(sub).toMatchObject({ feed_url: PUB, title: 'A Blog', active: 1, pds_dirty: 0 });
    expect(sub.atmosphere_synced).not.toBeNull();
  });

  it('flags the new row for the next sync when sync is on', async () => {
    await applyGraphEdgeCreate(env, READER, 'leaflet1', PUB, ON);
    expect((await subs())[0].pds_dirty).toBe(1);
  });

  it('ignores records that are not publication follows', async () => {
    expect(await applyGraphEdgeCreate(env, READER, 'x', 'https://not.a.pub', OFF)).toBe('skipped');
    expect(await subs()).toHaveLength(0);
  });

  it('does not bring back a follow the reader unsubscribed from here', async () => {
    await applyGraphEdgeCreate(env, READER, 'leaflet1', PUB, OFF);
    await env.DB.prepare('DELETE FROM subscriptions_cache').run();

    expect(await applyGraphEdgeCreate(env, READER, 'leaflet1', PUB, OFF)).toBe('known');
    graph = [{ rkey: 'leaflet1', publication: PUB }];
    await scanGraphFollows(env, READER);
    expect(await subs()).toHaveLength(0);
  });

  it('removes an imported follow when it is unfollowed elsewhere', async () => {
    await applyGraphEdgeCreate(env, READER, 'leaflet1', PUB, OFF);
    expect(await applyGraphEdgeDelete(env, READER, 'leaflet1', OFF)).toBe('removed');
    expect(await subs()).toHaveLength(0);
    // A re-follow is a new record, and imports again.
    expect(await applyGraphEdgeCreate(env, READER, 'leaflet2', PUB, OFF)).toBe('imported');
  });

  it('keeps a feed the reader already followed here', async () => {
    await followHere(PUB);
    expect(await applyGraphEdgeCreate(env, READER, 'leaflet1', PUB, OFF)).toBe('claimed');
    expect(await applyGraphEdgeDelete(env, READER, 'leaflet1', OFF)).toBe('kept');
    expect(await subs()).toHaveLength(1);
  });

  it('keeps a follow still held by another graph record', async () => {
    await applyGraphEdgeCreate(env, READER, 'leaflet1', PUB, OFF);
    await applyGraphEdgeCreate(env, READER, 'otherapp', PUB, OFF);
    expect(await applyGraphEdgeDelete(env, READER, 'leaflet1', OFF)).toBe('kept');
    expect(await subs()).toHaveLength(1);
  });

  it('ignores deletes of records it never saw', async () => {
    expect(await applyGraphEdgeDelete(env, READER, 'nope', OFF)).toBe('unknown');
  });

  it('leaves a synced unfollow to the reconcile when no session can delete its record', async () => {
    await applyGraphEdgeCreate(env, READER, 'leaflet1', PUB, ON);
    expect(await applyGraphEdgeDelete(env, READER, 'leaflet1', ON)).toBe('deferred');
    expect(await subs()).toHaveLength(1);
  });

  it('scans the graph: imports what is new, removes what is gone, marks it done', async () => {
    graph = [
      { rkey: 'a', publication: PUB },
      { rkey: 'b', publication: PUB2 },
    ];
    await scanGraphFollows(env, READER);
    expect((await subs()).map((s) => s.feed_url)).toEqual([PUB, PUB2]);

    graph = [{ rkey: 'b', publication: PUB2 }];
    await scanGraphFollows(env, READER);
    expect((await subs()).map((s) => s.feed_url)).toEqual([PUB2]);

    const scan = await env.DB.prepare(
      'SELECT scanned_at, queued_at FROM atmosphere_graph_scans'
    ).first<{ scanned_at: number | null; queued_at: number | null }>();
    expect(scan?.scanned_at).not.toBeNull();
    expect(scan?.queued_at).toBeNull();
  });

  it('queues never-scanned readers once, not every minute', async () => {
    const sent: unknown[] = [];
    const jobs = { sendBatch: async (b: unknown[]) => void sent.push(...b) };
    const testEnv = { ...env, JOBS: jobs } as unknown as Env;

    expect(await enqueueDueGraphScans(testEnv, 5)).toBe(1);
    expect(sent).toEqual([{ body: { type: 'atmosphere.graphScan', did: READER } }]);
    expect(await enqueueDueGraphScans(testEnv, 5)).toBe(0);

    // Scanned just now: not due again for a week.
    await scanGraphFollows(env, READER);
    expect(await enqueueDueGraphScans(testEnv, 5)).toBe(0);
  });
});
