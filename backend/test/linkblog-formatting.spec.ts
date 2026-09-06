import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES, LINKBLOG_SCOPES } from '../src/config/scopes';
import { getLinkblogFormatting } from '../src/services/linkblog-sync';

// How a link post is formatted on someone else's site is a per-user preference
// (see migration 0076): the title decoration that keeps a share from reading as a
// repost of the article, and where the link card sits relative to the note.
//
// What matters here:
//  - Defaults come back for a user who has never chosen ('link' + 'context').
//  - Only the known enum values are accepted; a bad value is a 400, not a stored
//    string that would silently mean "the default" forever after.
//  - A partial update leaves the other field alone.
//  - The choices ride back on the publication meta the settings page already loads.

const GRANTED_SCOPES = [GRANULAR_SCOPES, ...LINKBLOG_SCOPES].join(' ');

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DPOP_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
};

const TEST_DID = 'did:plc:formattingtest';
const TEST_SESSION_ID = 'test-session-formatting';

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

function setFormatting(body: unknown) {
  return send(makeAuthRequest('/api/linkblog/formatting', { method: 'PUT', body }));
}

interface Meta {
  formatting: { titleStyle: string; cardPosition: string };
}

// The publication record doesn't exist yet (nothing has been shared), which is
// exactly the state the settings page renders in before a first share.
function stubPds() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('getRecord')) {
      return new Response(JSON.stringify({ error: 'RecordNotFound' }), { status: 404 });
    }
    if (url.includes('listRecords')) {
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe('linkblog post formatting', () => {
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    for (const [table, column] of [
      ['user_settings', 'user_did'],
      ['sessions', 'did'],
      ['users', 'did'],
    ]) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(TEST_DID).run();
    }
    await env.DB.prepare(
      'INSERT INTO users (did, handle, pds_url, created_at) VALUES (?, ?, ?, unixepoch())'
    )
      .bind(TEST_DID, 'formatting.test', 'https://test.pds.example')
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        TEST_SESSION_ID,
        TEST_DID,
        'formatting.test',
        'https://test.pds.example',
        'test-access-token',
        'test-refresh-token',
        JSON.stringify(TEST_DPOP_KEY),
        Date.now() + 3600000,
        GRANTED_SCOPES
      )
      .run();
    stubPds();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('reports the new defaults for a user who has never chosen', async () => {
    expect(await getLinkblogFormatting(env, TEST_DID)).toEqual({
      titleStyle: 'link',
      cardPosition: 'context',
    });
    const res = await send(makeAuthRequest('/api/linkblog/publication'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Meta).formatting).toEqual({
      titleStyle: 'link',
      cardPosition: 'context',
    });
  });

  it('stores both choices and reports them on the publication meta', async () => {
    const res = await setFormatting({ titleStyle: 'quoted', cardPosition: 'bottom' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Meta).formatting).toEqual({
      titleStyle: 'quoted',
      cardPosition: 'bottom',
    });
    expect(await getLinkblogFormatting(env, TEST_DID)).toEqual({
      titleStyle: 'quoted',
      cardPosition: 'bottom',
    });
  });

  it('leaves the other field alone on a partial update', async () => {
    await setFormatting({ titleStyle: 'plain', cardPosition: 'top' });
    const res = await setFormatting({ cardPosition: 'context' });
    expect(((await res.json()) as Meta).formatting).toEqual({
      titleStyle: 'plain',
      cardPosition: 'context',
    });
  });

  it.each([{ titleStyle: 'emoji' }, { cardPosition: 'middle' }, { titleStyle: 42 }])(
    'rejects %o rather than storing it',
    async (body) => {
      const res = await setFormatting(body);
      expect(res.status).toBe(400);
      expect(await getLinkblogFormatting(env, TEST_DID)).toEqual({
        titleStyle: 'link',
        cardPosition: 'context',
      });
    }
  );

  it('needs a session', async () => {
    const res = await send(
      new IncomingRequest('http://localhost/api/linkblog/formatting', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: env.FRONTEND_URL },
        body: JSON.stringify({ titleStyle: 'plain' }),
      })
    );
    expect(res.status).toBe(401);
  });
});
