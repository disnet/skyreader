import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as pdsClient from '../src/services/pds-client';
import {
  GRANULAR_SCOPES,
  SEMBLE_SCOPES,
  SEMBLE_CONNECTION_SCOPES,
  ALL_POSSIBLE_SCOPES,
} from '../src/config/scopes';

// Route-level coverage for POST /api/integrations/semble/connections: the record
// shape written to the PDS (a foreign, unversioned lexicon — so it's pinned
// verbatim), the validation gate, and the scope split that keeps existing Semble
// card saves working for sessions that predate the connection scope.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:sembleconn';
const SESSION = 'sess-semble-conn';
const COLLECTION = 'network.cosmik.connection';

const SOURCE = 'https://example.test/the-article';
const TARGET = 'https://other.test/the-rebuttal';

// What a session gets after re-authing: everything login requests.
const FULL_SCOPES = ALL_POSSIBLE_SCOPES;
// A pre-existing Semble user: card/collection scopes, but not the connection one.
const OLD_SEMBLE_SCOPES = `${GRANULAR_SCOPES} ${SEMBLE_SCOPES.join(' ')}`;

async function reset(grantedScopes = FULL_SCOPES) {
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'conn.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'conn.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
    .run();
}

function fakePds(
  putRecord = vi.fn(async () => ({ success: true, data: { uri: 'at://x', cid: 'c' } }))
) {
  vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ putRecord } as never);
  return putRecord;
}

function post(body: unknown, method = 'POST') {
  return new IncomingRequest('http://localhost/api/integrations/semble/connections', {
    method,
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function getCards() {
  return new IncomingRequest('http://localhost/api/integrations/semble/cards', {
    method: 'GET',
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
    },
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('the connection scope is split from the Semble scopes', () => {
  it('is requested at login', () => {
    for (const scope of SEMBLE_CONNECTION_SCOPES) {
      expect(ALL_POSSIBLE_SCOPES).toContain(scope);
    }
  });

  it('is not part of SEMBLE_SCOPES — card saves must not start failing', () => {
    for (const scope of SEMBLE_CONNECTION_SCOPES) {
      expect(SEMBLE_SCOPES).not.toContain(scope);
    }
  });
});

describe('GET /api/integrations/semble/cards', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('lists every URL card in the reader PDS for connection search', async () => {
    const listAllRecords = vi.fn(async () => ({
      success: true as const,
      truncated: false,
      data: [
        {
          uri: `at://${DID}/network.cosmik.card/c1`,
          cid: 'bafy1',
          value: {
            type: 'URL',
            content: {
              url: TARGET,
              metadata: { title: 'A careful rebuttal', author: 'A. Reader' },
            },
            createdAt: '2026-08-26T00:00:00.000Z',
          },
        },
        {
          uri: `at://${DID}/network.cosmik.card/note1`,
          cid: 'bafy2',
          value: { type: 'NOTE', content: {} },
        },
      ],
    }));
    vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ listAllRecords } as never);

    const { status, body } = await call(getCards());

    expect(status).toBe(200);
    expect(listAllRecords).toHaveBeenCalledWith('network.cosmik.card');
    expect(body).toEqual({
      cards: [
        {
          uri: `at://${DID}/network.cosmik.card/c1`,
          cid: 'bafy1',
          url: TARGET,
          title: 'A careful rebuttal',
          author: 'A. Reader',
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      truncated: false,
    });
  });

  it('keeps the existing Semble scope gate for listing cards', async () => {
    await reset('repo:network.cosmik.connection');

    const { status, body } = await call(getCards());

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'scope_upgrade_required', integration: 'semble' });
  });
});

describe('POST /api/integrations/semble/connections', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('writes a network.cosmik.connection under a TID rkey and returns it', async () => {
    const putRecord = fakePds(
      vi.fn(async () => ({
        success: true,
        data: { uri: `at://${DID}/${COLLECTION}/abc`, cid: 'bafyconn' },
      }))
    );

    const { status, body } = await call(
      post({ source: SOURCE, target: TARGET, connectionType: 'SUPPORTS', note: 'Worth reading.' })
    );

    expect(status).toBe(201);
    expect(body).toMatchObject({ uri: `at://${DID}/${COLLECTION}/abc`, cid: 'bafyconn' });
    expect(putRecord).toHaveBeenCalledTimes(1);

    const [collection, rkey, record] = putRecord.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(collection).toBe(COLLECTION);
    expect(rkey).toMatch(/^[a-z0-9]{13,}$/); // a freshly minted TID
    expect(record.$type).toBe(COLLECTION);
    expect(record.source).toBe(SOURCE);
    expect(record.target).toBe(TARGET);
    expect(record.connectionType).toBe('SUPPORTS');
    expect(record.note).toBe('Worth reading.');
    expect(typeof record.createdAt).toBe('string');
    expect(record.updatedAt).toBe(record.createdAt);
    expect(body.rkey).toBe(rkey);
  });

  it('omits the optional fields rather than writing empty ones', async () => {
    const putRecord = fakePds();
    await call(post({ source: SOURCE, target: TARGET }));

    const record = (putRecord.mock.calls[0] as unknown as [string, string, object])[2];
    expect(record).not.toHaveProperty('connectionType');
    expect(record).not.toHaveProperty('note');
  });

  it('trims the endpoints before writing them', async () => {
    const putRecord = fakePds();
    await call(post({ source: `  ${SOURCE} `, target: `${TARGET}\n` }));

    const record = (
      putRecord.mock.calls[0] as unknown as [string, string, Record<string, string>]
    )[2];
    expect(record.source).toBe(SOURCE);
    expect(record.target).toBe(TARGET);
  });

  it.each([
    ['a missing target', { source: SOURCE }],
    ['a non-http source', { source: 'javascript:alert(1)', target: TARGET }],
    ['a non-http target', { source: SOURCE, target: 'not a url' }],
    ['an unknown connectionType', { source: SOURCE, target: TARGET, connectionType: 'ENDORSES' }],
    ['an edge to itself', { source: SOURCE, target: ` ${SOURCE}` }],
  ])('rejects %s with a 400 and writes nothing', async (_label, body) => {
    const putRecord = fakePds();
    const res = await call(post(body));
    expect(res.status).toBe(400);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('rejects a note over 1000 bytes', async () => {
    const putRecord = fakePds();
    // 501 two-byte characters: under the limit by character count, over it by bytes.
    const res = await call(post({ source: SOURCE, target: TARGET, note: 'é'.repeat(501) }));
    expect(res.status).toBe(400);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('accepts a note of exactly 1000 bytes', async () => {
    const putRecord = fakePds();
    const res = await call(post({ source: SOURCE, target: TARGET, note: 'a'.repeat(1000) }));
    expect(res.status).toBe(201);
    expect(putRecord).toHaveBeenCalledTimes(1);
  });

  it('answers 403 scope_upgrade_required for a session without the connection scope', async () => {
    await reset(OLD_SEMBLE_SCOPES);
    const putRecord = fakePds();

    const { status, body } = await call(post({ source: SOURCE, target: TARGET }));

    expect(status).toBe(403);
    expect(body.error).toBe('scope_upgrade_required');
    // The frontend banner keys off the reader-facing integration name.
    expect(body.integration).toBe('semble');
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('surfaces a PDS failure as a 502', async () => {
    fakePds(vi.fn(async () => ({ success: false, error: 'PDS unavailable' })) as never);
    const { status, body } = await call(post({ source: SOURCE, target: TARGET }));
    expect(status).toBe(502);
    expect(body.error).toBe('PDS unavailable');
  });

  it('rejects a non-POST method', async () => {
    const { status } = await call(post(undefined, 'GET'));
    expect(status).toBe(405);
  });
});

describe('GET /api/integrations/status', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('reports the connection scope separately from the Semble scopes', async () => {
    await reset(OLD_SEMBLE_SCOPES);
    const req = new IncomingRequest('http://localhost/api/integrations/status', {
      headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
    });
    const { status, body } = await call(req);
    expect(status).toBe(200);
    expect(body.scopeStatus.semble).toBe(true);
    expect(body.scopeStatus.sembleConnections).toBe(false);
  });
});
