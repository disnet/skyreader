import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import {
  CITATIONS_MISS_TTL_MS,
  CITATIONS_TTL_MS,
  citingWork,
  getPaperCitations,
  prunePaperCitations,
} from '../src/services/paper-citations';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:cites123';
const TEST_SESSION_ID = 'test-session-citations';
const DOI = '10.48550/arXiv.2401.12345';

async function setupUser() {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, ?, 'free', unixepoch())`
  )
    .bind(TEST_DID, 'cites.bsky.social', 'https://test.pds.example')
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      TEST_SESSION_ID,
      TEST_DID,
      'cites.bsky.social',
      'https://test.pds.example',
      'test-access-token',
      'test-refresh-token',
      JSON.stringify({ kty: 'EC' }),
      Date.now() + 3600000,
      GRANULAR_SCOPES
    )
    .run();
}

async function get(path: string, signedIn = true) {
  const headers: Record<string, string> = { Origin: env.FRONTEND_URL };
  if (signedIn) headers.Cookie = `session_id=${TEST_SESSION_ID}`;
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, { headers }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Answers OpenAlex; counts the calls of each kind. */
function stubOpenAlex(
  opts: { citedBy?: number; known?: boolean; fail?: boolean; listFails?: boolean } = {}
) {
  const calls = { lookup: 0, list: 0, urls: [] as string[] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.urls.push(url);
    if (opts.fail) return new Response('busy', { status: 503 });
    if (url.includes('api.openalex.org/works/doi:')) {
      calls.lookup++;
      if (opts.known === false) return new Response('not found', { status: 404 });
      return Response.json({ id: 'https://openalex.org/W42', cited_by_count: opts.citedBy ?? 2 });
    }
    if (url.includes('api.openalex.org/works?')) {
      calls.list++;
      if (opts.listFails) return new Response('budget', { status: 429 });
      return Response.json({
        results: [
          {
            id: 'https://openalex.org/W7',
            doi: 'https://doi.org/10.1000/cites.it',
            display_name: 'A paper that builds on it',
            publication_year: 2025,
            cited_by_count: 40,
            authorships: [
              { author: { display_name: 'Ada Lovelace' } },
              { author: { display_name: 'Alan Turing' } },
              { author: { display_name: 'Grace Hopper' } },
              { author: { display_name: 'Edsger Dijkstra' } },
            ],
            primary_location: { source: { display_name: 'Journal of Things' } },
          },
          // The same DOI under a second record: said once.
          {
            id: 'https://openalex.org/W77',
            doi: 'https://doi.org/10.1000/CITES.IT',
            display_name: 'A paper that builds on it (journal version)',
          },
          // No title: left out.
          { id: 'https://openalex.org/W8', display_name: null },
          {
            id: 'https://openalex.org/W9',
            doi: null,
            display_name: 'A preprint with no DOI',
            publication_year: null,
            cited_by_count: 0,
            authorships: [],
            primary_location: null,
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

describe('Cited by: the works citing a paper', () => {
  beforeEach(async () => {
    for (const table of ['paper_citations', 'rate_limits', 'sessions', 'users']) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await setupUser();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the most-cited citing works, with authors, venue and a link out', async () => {
    const calls = stubOpenAlex({ citedBy: 12 });
    const { status, body } = await get(`/api/papers/citations?doi=${encodeURIComponent(DOI)}`);
    expect(status).toBe(200);
    expect(body.doi).toBe(DOI.toLowerCase());
    expect(body.total).toBe(12);
    expect(body.allUrl).toBe('https://openalex.org/works?filter=cites%3AW42');
    expect(body.works).toEqual([
      {
        title: 'A paper that builds on it',
        authors: ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'],
        moreAuthors: 1,
        year: 2025,
        venue: 'Journal of Things',
        doi: '10.1000/cites.it',
        url: 'https://doi.org/10.1000/cites.it',
        citedBy: 40,
      },
      {
        title: 'A preprint with no DOI',
        authors: [],
        moreAuthors: 0,
        year: null,
        venue: null,
        doi: null,
        url: 'https://openalex.org/W9',
        citedBy: 0,
      },
    ]);
    const list = calls.urls.find((u) => u.includes('/works?'))!;
    expect(new URL(list).searchParams.get('filter')).toBe('cites:W42');
    expect(new URL(list).searchParams.get('sort')).toBe('cited_by_count:desc');
  });

  it('asks OpenAlex once a week per paper, whatever the DOI case', async () => {
    const calls = stubOpenAlex({ citedBy: 3 });
    const now = Date.now();
    await getPaperCitations(env, DOI.toLowerCase(), now);
    const { status } = await get(
      `/api/papers/citations?doi=${encodeURIComponent(DOI.toUpperCase())}`
    );
    expect(status).toBe(200);
    expect(calls).toMatchObject({ lookup: 1, list: 1 });

    await getPaperCitations(env, DOI.toLowerCase(), now + CITATIONS_TTL_MS + 1);
    expect(calls).toMatchObject({ lookup: 2, list: 2 });
  });

  it('skips the list call for an uncited paper and caches a miss for a day', async () => {
    const calls = stubOpenAlex({ citedBy: 0 });
    const uncited = await getPaperCitations(env, '10.1000/uncited', 1_000);
    expect(uncited).toMatchObject({ total: 0, works: [] });
    expect(calls).toMatchObject({ lookup: 1, list: 0 });

    vi.restoreAllMocks();
    const missCalls = stubOpenAlex({ known: false });
    const now = Date.now();
    const miss = await getPaperCitations(env, '10.1000/unknown', now);
    expect(miss).toMatchObject({ total: 0, works: [], allUrl: null });
    await getPaperCitations(env, '10.1000/unknown', now + CITATIONS_MISS_TTL_MS - 1);
    expect(missCalls.lookup).toBe(1);
    await getPaperCitations(env, '10.1000/unknown', now + CITATIONS_MISS_TTL_MS + 1);
    expect(missCalls.lookup).toBe(2);
  });

  it('serves a stale answer when OpenAlex fails, and 502 with nothing cached', async () => {
    stubOpenAlex({ citedBy: 5 });
    const now = Date.now();
    await getPaperCitations(env, DOI.toLowerCase(), now - CITATIONS_TTL_MS - 1);
    vi.restoreAllMocks();
    stubOpenAlex({ fail: true });
    const stale = await getPaperCitations(env, DOI.toLowerCase(), now);
    expect(stale.total).toBe(5);

    const { status } = await get('/api/papers/citations?doi=10.1000/never.seen');
    expect(status).toBe(502);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM paper_citations`).first('n')).toBe(1);
  });

  it('keeps the total, uncached, when only the list call fails', async () => {
    const calls = stubOpenAlex({ citedBy: 9, listFails: true });
    const { status, body } = await get(`/api/papers/citations?doi=${encodeURIComponent(DOI)}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 9, works: [] });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM paper_citations`).first('n')).toBe(0);
    await get(`/api/papers/citations?doi=${encodeURIComponent(DOI)}`);
    expect(calls.lookup).toBe(2);
  });

  it("stops a reader after a day's worth of papers", async () => {
    stubOpenAlex({ citedBy: 0 });
    const windowMs = 86_400_000;
    await env.DB.prepare(
      `INSERT INTO rate_limits (did, endpoint, window_start, count) VALUES (?, ?, ?, 300)`
    )
      .bind(TEST_DID, '/api/papers/citations:day', Math.floor(Date.now() / windowMs) * windowMs)
      .run();
    expect((await get('/api/papers/citations?doi=10.1000/one.more')).status).toBe(429);
  });

  it('refuses a non-DOI and a signed-out request', async () => {
    const calls = stubOpenAlex();
    expect((await get('/api/papers/citations?doi=not-a-doi')).status).toBe(400);
    expect((await get('/api/papers/citations')).status).toBe(400);
    expect((await get(`/api/papers/citations?doi=${DOI}`, false)).status).toBe(401);
    expect(calls.urls).toHaveLength(0);
  });

  it('sweeps rows a month past their fetch', async () => {
    stubOpenAlex();
    const now = Date.now();
    await getPaperCitations(env, '10.1000/old', now - 31 * 24 * 60 * 60 * 1000);
    await getPaperCitations(env, '10.1000/new', now);
    await prunePaperCitations(env, now);
    const rows = await env.DB.prepare(`SELECT doi FROM paper_citations`).all<{ doi: string }>();
    expect(rows.results.map((r) => r.doi)).toEqual(['10.1000/new']);
  });

  it('only links a citing work to doi.org or openalex.org', () => {
    expect(
      citingWork({ id: 'https://evil.example/W1', display_name: 'x', doi: 'javascript:alert(1)' })
    ).toBeNull();
    expect(citingWork({ id: 'https://openalex.org/W1', display_name: 'x' })?.url).toBe(
      'https://openalex.org/W1'
    );
  });
});
