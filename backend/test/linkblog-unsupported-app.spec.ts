import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';

// pckt builds its site from the posts pckt itself wrote — it does not watch the
// firehose for records that turn up in a repo it already knows. A Skyreader link
// post lands in the user's pckt publication as a correct `blog.pckt.content`
// document with a correct `blog.pckt.document` companion, and pckt's site never
// shows it. Nothing about how we write helps, so the publication is listed with
// the reason and the connect is refused server-side — a setting that silently
// publishes into a void is worse than no setting.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const TEST_DID = 'did:plc:pcktauthor';
const TEST_SESSION_ID = 'test-session-pckt';
const PCKT_URI = `at://${TEST_DID}/site.standard.publication/my-pckt`;
const LEAFLET_URI = `at://${TEST_DID}/site.standard.publication/my-leaflet`;

function makeAuthRequest(path: string, opts?: { method?: string; body?: unknown }) {
  return new IncomingRequest(`http://localhost${path}`, {
    method: opts?.method ?? 'GET',
    headers: {
      Cookie: `session_id=${TEST_SESSION_ID}`,
      'Content-Type': 'application/json',
      Origin: env.FRONTEND_URL,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function send(request: Request) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request as never, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// Both publications are empty, so each one is placed by its host alone — the
// weaker of the two signals, and the one a user hits when they connect a fresh
// publication before writing anything in it.
const PUBLICATIONS = [
  { uri: PCKT_URI, cid: 'bafy1', value: { name: 'My pckt blog', url: 'https://me.pckt.blog/' } },
  { uri: LEAFLET_URI, cid: 'bafy2', value: { name: 'My essays', url: 'https://leaflet.pub/me' } },
];

function stubPds() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('listRecords')) {
      const collection = new URL(url).searchParams.get('collection');
      return new Response(
        JSON.stringify({
          records: collection === 'site.standard.publication' ? PUBLICATIONS : [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('getRecord')) {
      const rkey = new URL(url).searchParams.get('rkey');
      const record = PUBLICATIONS.find((p) => p.uri.endsWith(`/${rkey}`));
      if (!record) return new Response(JSON.stringify({ error: 'NotFound' }), { status: 404 });
      return new Response(JSON.stringify(record), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

async function connectedPublication(): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT linkblog_publication FROM user_settings WHERE user_did = ?'
  )
    .bind(TEST_DID)
    .first<{ linkblog_publication: string | null }>();
  return row?.linkblog_publication ?? null;
}

describe('a publication whose app ignores foreign records', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    for (const table of ['user_settings', 'sessions', 'users']) {
      const column = table === 'users' ? 'did' : table === 'sessions' ? 'did' : 'user_did';
      await env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(TEST_DID).run();
    }
    await env.DB.prepare(
      'INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
    )
      .bind(TEST_DID, 'pckt.test', 'https://test.pds.example')
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        TEST_SESSION_ID,
        TEST_DID,
        'pckt.test',
        'https://test.pds.example',
        'test-access-token',
        'test-refresh-token',
        JSON.stringify(TEST_DPOP_KEY),
        Date.now() + 3600000
      )
      .run();
    stubPds();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('is still listed, marked with the reason it cannot be used', async () => {
    const res = await send(makeAuthRequest('/api/linkblog/publications'));
    expect(res.status).toBe(200);
    const { publications } = (await res.json()) as {
      publications: Array<{
        uri: string;
        appId?: string;
        supported: boolean;
        unsupportedReason?: string;
      }>;
    };

    const pckt = publications.find((p) => p.uri === PCKT_URI);
    expect(pckt?.appId).toBe('pckt');
    expect(pckt?.supported).toBe(false);
    expect(pckt?.unsupportedReason).toMatch(/pckt/);

    // Every other publication the user owns is unaffected.
    expect(publications.find((p) => p.uri === LEAFLET_URI)?.supported).toBe(true);
    expect(publications.find((p) => p.uri === LEAFLET_URI)?.unsupportedReason).toBeUndefined();
  });

  it('is refused by connect, and nothing is stored', async () => {
    const res = await send(
      makeAuthRequest('/api/linkblog/publication/connect', {
        method: 'PUT',
        body: { publicationUri: PCKT_URI },
      })
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/pckt/);
    expect(await connectedPublication()).toBeNull();
  });

  it('still connects a publication whose app does render our posts', async () => {
    const res = await send(
      makeAuthRequest('/api/linkblog/publication/connect', {
        method: 'PUT',
        body: { publicationUri: LEAFLET_URI },
      })
    );

    expect(res.status).toBe(200);
    expect(await connectedPublication()).toBe(LEAFLET_URI);
  });

  it('rejects a request asking for pckt blocks anywhere', async () => {
    // pckt is no longer a writable output format, so even a publication that
    // leaves the format open cannot be pointed at one nothing will render.
    const res = await send(
      makeAuthRequest('/api/linkblog/publication/connect', {
        method: 'PUT',
        body: { publicationUri: LEAFLET_URI, format: 'pckt' },
      })
    );

    expect(res.status).toBe(400);
    expect(await connectedPublication()).toBeNull();
  });
});
