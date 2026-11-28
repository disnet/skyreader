import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import {
  enqueueDueWatchChecks,
  laneGrowth,
  pruneSaveWatches,
  runWatchCheck,
} from '../src/services/save-watches';
import { normalizeArticleUrl } from '../src/utils/url-normalize';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:watch123';
const OTHER_DID = 'did:plc:watch456';
const TEST_SESSION_ID = 'test-session-watches';

const URL1 = 'https://example.com/essay';
const PAPER = 'https://arxiv.org/abs/2401.12345';

async function setupUser(did: string, tier = 'free', session?: string) {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, ?, unixepoch())`
  )
    .bind(did, `${did.slice(-6)}.bsky.social`, 'https://test.pds.example', tier)
    .run();
  if (!session) return;
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      session,
      did,
      'watch.bsky.social',
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000,
      GRANULAR_SCOPES
    )
    .run();
}

async function save(rkey: string, url: string, did = TEST_DID) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, url, url_key, saved_at) VALUES (?, ?, ?, NULL, ?)`
  )
    .bind(did, rkey, url, 1000)
    .run();
}

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    Origin: env.FRONTEND_URL,
    Cookie: `session_id=${TEST_SESSION_ID}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function watches() {
  const { status, body } = await call('GET', '/api/saved/watches');
  expect(status).toBe(200);
  return body as {
    limit: number;
    items: Array<{
      rkey: string;
      unseen: number;
      citations: boolean;
      events: Array<{
        kind: string;
        lane: string | null;
        count: number;
        detail: Array<Record<string, unknown>>;
      }>;
    }>;
  };
}

/** Answers the feed proxy's /mentions and /mention-lane, and OpenAlex. */
function stubNetwork(opts: {
  lanes?: Record<string, number>;
  pending?: boolean;
  checkedAt?: number | null;
  entries?: Array<{ did: string; handle: string; createdAt: string; url: string }>;
  citedBy?: number;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/mentions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { urls: string[]; maxAgeMs?: number };
      expect(body.maxAgeMs).toBeGreaterThan(0);
      const lanes = Object.entries(opts.lanes ?? {}).map(([lane, count]) => ({
        lane,
        label: lane,
        verb: 'posted',
        noun: lane,
        icon: lane,
        count,
        capped: false,
      }));
      return Response.json({
        items: body.urls.map((u) => ({
          url: u,
          total: lanes.reduce((n, l) => n + l.count, 0),
          lanes,
          pending: opts.pending ?? false,
          checkedAt: opts.checkedAt ?? null,
        })),
      });
    }
    if (url.endsWith('/mention-lane')) {
      return Response.json({
        entries: (opts.entries ?? []).map((e) => ({
          ...e,
          displayName: null,
          avatar: null,
          note: null,
          collections: [],
          verb: null,
          quote: null,
          likeCount: null,
        })),
      });
    }
    if (url.includes('api.openalex.org/works/doi:')) {
      return Response.json({ id: 'https://openalex.org/W42', cited_by_count: opts.citedBy ?? 0 });
    }
    if (url.includes('api.openalex.org/works?')) {
      expect(url).toContain('cites%3AW42');
      return Response.json({
        results: [
          {
            id: 'https://openalex.org/W99',
            doi: 'https://doi.org/10.1/new',
            display_name: 'A citing paper',
            publication_year: 2026,
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe('Watch for updates on saves', () => {
  beforeEach(async () => {
    for (const table of [
      'save_watches',
      'watch_targets',
      'watch_events',
      'saved_articles',
      'sessions',
      'users',
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await setupUser(TEST_DID, 'free', TEST_SESSION_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('watches saves up to the plan cap, refusing uploads and strangers', async () => {
    for (let i = 1; i <= 6; i++) await save(`3kwatchsave00${i}`, `https://example.com/p${i}`);
    await save('3kwatchupload1', '');

    const { status, body } = await call('POST', '/api/saved/watches', {
      rkeys: [
        '3kwatchupload1',
        '3kwatchsave001',
        '3kwatchsave002',
        '3kwatchsave003',
        '3kwatchsave004',
        '3kwatchsave005',
        '3kwatchsave006',
        '3kwatchnosuch1',
      ],
      watch: true,
    });
    expect(status).toBe(200);
    expect(body.limit).toBe(5);
    expect(body.watched).toHaveLength(5);
    expect(body.refused).toEqual([
      { rkey: '3kwatchupload1', reason: 'no_url' },
      { rkey: '3kwatchsave006', reason: 'limit' },
      { rkey: '3kwatchnosuch1', reason: 'not_found' },
    ]);

    // Watching one already watched costs nothing.
    const again = await call('POST', '/api/saved/watches', {
      rkeys: ['3kwatchsave001'],
      watch: true,
    });
    expect(again.body.watched).toEqual(['3kwatchsave001']);

    // Unwatching frees a slot and drops the URL nobody else watches.
    await call('POST', '/api/saved/watches', { rkeys: ['3kwatchsave001'], watch: false });
    const target = await env.DB.prepare('SELECT 1 FROM watch_targets WHERE url = ?')
      .bind('https://example.com/p1')
      .first();
    expect(target).toBeNull();
    const more = await call('POST', '/api/saved/watches', {
      rkeys: ['3kwatchsave006'],
      watch: true,
    });
    expect(more.body.watched).toEqual(['3kwatchsave006']);
    expect((await watches()).items).toHaveLength(5);
  });

  it('records a baseline first, then reports lanes that grew, with names', async () => {
    await save('3kwatchsave001', URL1);
    await call('POST', '/api/saved/watches', { rkeys: ['3kwatchsave001'], watch: true });
    const urlKey = normalizeArticleUrl(URL1)!;

    // A cold URL: the proxy is still asking, so no baseline yet.
    stubNetwork({ lanes: {}, pending: true });
    await runWatchCheck(env, 'mentions', [urlKey]);
    const row = await env.DB.prepare('SELECT mention_counts FROM watch_targets WHERE url_key = ?')
      .bind(urlKey)
      .first<{ mention_counts: string | null }>();
    expect(row?.mention_counts).toBeNull();
    vi.restoreAllMocks();

    // Settled: the baseline, reported as nothing.
    stubNetwork({ lanes: { bluesky: 2, semble: 1 } });
    await runWatchCheck(env, 'mentions', [urlKey]);
    expect((await watches()).items[0].unseen).toBe(0);
    vi.restoreAllMocks();

    // A refresh under way: no comparing stale counts, even with a baseline.
    stubNetwork({ lanes: { bluesky: 9 }, pending: true });
    await runWatchCheck(env, 'mentions', [urlKey]);
    expect((await watches()).items[0].unseen).toBe(0);
    vi.restoreAllMocks();

    // Two more people on Bluesky, one on margin.at; Semble isn't this lane's news.
    // Refreshing, but the cached counts are minutes old (a young URL): compared.
    const later = new Date(Date.now() + 60_000).toISOString();
    stubNetwork({
      lanes: { bluesky: 4, margin: 1, semble: 3 },
      pending: true,
      checkedAt: Date.now() - 60_000,
      entries: [
        { did: 'did:plc:a', handle: 'a.test', createdAt: later, url: 'https://bsky.app/a' },
        { did: 'did:plc:old', handle: 'old.test', createdAt: '2020-01-01T00:00:00Z', url: null! },
      ],
    });
    await runWatchCheck(env, 'mentions', [urlKey]);
    const { items } = await watches();
    expect(items[0].unseen).toBe(2);
    const bluesky = items[0].events.find((e) => e.lane === 'bluesky')!;
    expect(bluesky).toMatchObject({ kind: 'mentions', count: 2 });
    expect(bluesky.detail.map((d) => d.handle)).toEqual(['a.test']);
    expect(items[0].events.find((e) => e.lane === 'margin')?.count).toBe(1);

    // Clearing up to what was shown hides those, but not news that came after.
    const shown = (await env.DB.prepare('SELECT MAX(created_at) AS at FROM watch_events').first(
      'at'
    )) as number;
    await env.DB.prepare(
      `INSERT INTO watch_events (url_key, kind, lane, count, baseline_at, created_at) VALUES (?, 'mentions', 'leaflet', 1, ?, ?)`
    )
      .bind(urlKey, shown, shown + 5)
      .run();
    await call('POST', '/api/saved/watches/seen', { rkeys: ['3kwatchsave001'], until: shown });
    expect((await watches()).items[0].unseen).toBe(1);
    await call('POST', '/api/saved/watches/seen', { all: true });
    expect((await watches()).items[0].unseen).toBe(0);
  });

  it('checks citations on OpenAlex for a save with a DOI', async () => {
    await save('3kwatchpaper1', PAPER);
    await call('POST', '/api/saved/watches', { rkeys: ['3kwatchpaper1'], watch: true });
    expect((await watches()).items[0].citations).toBe(true);
    const urlKey = normalizeArticleUrl(PAPER)!;

    stubNetwork({ citedBy: 10 });
    await runWatchCheck(env, 'citations', [urlKey]);
    expect((await watches()).items[0].unseen).toBe(0);
    vi.restoreAllMocks();

    stubNetwork({ citedBy: 13 });
    await runWatchCheck(env, 'citations', [urlKey]);
    const event = (await watches()).items[0].events[0];
    expect(event).toMatchObject({ kind: 'citations', count: 3 });
    expect(event.detail[0]).toMatchObject({ title: 'A citing paper', year: 2026 });
  });

  it("doesn't hand a new watcher news from before they started watching", async () => {
    await setupUser(OTHER_DID);
    await save('3kwatchsave001', URL1);
    await save('3kwatchsave009', URL1, OTHER_DID);
    const urlKey = normalizeArticleUrl(URL1)!;
    // Someone else watches it, with a baseline from yesterday.
    await env.DB.prepare(
      `INSERT INTO save_watches (user_did, rkey, url_key, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(OTHER_DID, '3kwatchsave009', urlKey, Date.now() - 2 * 86_400_000)
      .run();
    await env.DB.prepare(
      `INSERT INTO watch_targets (url_key, url, mention_counts, mentions_checked_at) VALUES (?, ?, ?, ?)`
    )
      .bind(urlKey, URL1, JSON.stringify({ bluesky: 2 }), Date.now() - 86_400_000)
      .run();
    await call('POST', '/api/saved/watches', { rkeys: ['3kwatchsave001'], watch: true });

    stubNetwork({ lanes: { bluesky: 50 } });
    await runWatchCheck(env, 'mentions', [urlKey]);
    expect((await watches()).items[0].unseen).toBe(0);
    vi.restoreAllMocks();

    stubNetwork({ lanes: { bluesky: 51 } });
    await runWatchCheck(env, 'mentions', [urlKey]);
    expect((await watches()).items[0].events.map((e) => [e.lane, e.count])).toEqual([
      ['bluesky', 1],
    ]);
  });

  it('holds the cap when two requests race for the last slots', async () => {
    for (let i = 0; i < 10; i++) await save(`3kwatchrace0${i}`, `https://example.com/r${i}`);
    const rkeys = Array.from({ length: 10 }, (_, i) => `3kwatchrace0${i}`);
    const [a, b] = await Promise.all([
      call('POST', '/api/saved/watches', { rkeys: rkeys.slice(0, 5), watch: true }),
      call('POST', '/api/saved/watches', { rkeys: rkeys.slice(5), watch: true }),
    ]);
    expect(a.body.watched.length + b.body.watched.length).toBe(5);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM save_watches').first('n')).toBe(5);
  });

  it('checks a URL once however many readers watch it', async () => {
    await setupUser(OTHER_DID);
    await save('3kwatchsave001', URL1);
    await save('3kwatchsave009', `${URL1}?utm_source=x`, OTHER_DID);
    await call('POST', '/api/saved/watches', { rkeys: ['3kwatchsave001'], watch: true });
    await env.DB.prepare(
      `INSERT INTO save_watches (user_did, rkey, url_key, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(OTHER_DID, '3kwatchsave009', normalizeArticleUrl(URL1), Date.now())
      .run();
    const send = vi.fn();
    vi.spyOn(env.JOBS, 'sendBatch').mockImplementation(send);
    expect(await enqueueDueWatchChecks(env, 50)).toBe(1);
    // Queued now, so not again until it's done or overdue.
    expect(await enqueueDueWatchChecks(env, 50)).toBe(0);
  });

  it('watches and unwatches more saves than one statement can bind', async () => {
    await env.DB.prepare(`UPDATE users SET tier = 'supporter' WHERE did = ?`).bind(TEST_DID).run();
    const rkeys = Array.from({ length: 150 }, (_, i) => `3kwatchbulk${String(i).padStart(3, '0')}`);
    for (const [i, rkey] of rkeys.entries()) await save(rkey, `https://example.com/bulk/${i}`);
    const on = await call('POST', '/api/saved/watches', { rkeys, watch: true });
    expect(on.status).toBe(200);
    expect(on.body.watched).toHaveLength(150);
    const seen = await call('POST', '/api/saved/watches/seen', { rkeys });
    expect(seen.status).toBe(200);
    const off = await call('POST', '/api/saved/watches', { rkeys, watch: false });
    expect(off.status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM watch_targets').first('n')).toBe(0);
  });

  it('sweeps watches on deleted saves', async () => {
    await save('3kwatchsave001', URL1);
    await call('POST', '/api/saved/watches', { rkeys: ['3kwatchsave001'], watch: true });
    await env.DB.prepare('DELETE FROM saved_articles').run();
    await pruneSaveWatches(env);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM save_watches').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM watch_targets').first('n')).toBe(0);
  });

  it('counts growth per lane, ignoring shrinkage and unwatched lanes', () => {
    expect(laneGrowth({ bluesky: 3, margin: 2 }, { bluesky: 5, margin: 1, leaflet: 1 })).toEqual([
      ['bluesky', 2],
      ['leaflet', 1],
    ]);
  });
});
