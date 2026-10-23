import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as pdsClient from '../src/services/pds-client';
import * as didResolver from '../src/utils/did-resolver';
import { applySembleConnectionCommit } from '../src/services/semble-connections';
import { GRANULAR_SCOPES, LIKE_SCOPES } from '../src/config/scopes';
import { LIKE_COLLECTION } from '../src/routes/saved-connections';

// Liking a connection in New connections: a community.lexicon.interaction.like in
// the reader's repo pointing at the connection by strongRef. What's pinned: the
// record shape, idempotency (the D1 claim), the CID lookup for rows indexed
// before the poller kept CIDs, and that a failed write leaves nothing behind.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:liker';
const CURATOR = 'did:plc:curator1';
const SESSION = 'sess-connection-likes';
const SAVE_RKEY = '3ksavedlike001';
const SAVE_URL = 'https://example.com/essay';
const CONN_RKEY = '3kconnlike0001';
const CONN_URI = `at://${CURATOR}/network.cosmik.connection/${CONN_RKEY}`;
const WITH_LIKES = `${GRANULAR_SCOPES} ${LIKE_SCOPES.join(' ')}`;

async function reset(grantedScopes = WITH_LIKES) {
  for (const table of ['connection_likes', 'semble_connections', 'saved_articles']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'liker.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'liker.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
    .run();
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, url, url_key, saved_at) VALUES (?, ?, ?, ?, 1000)`
  )
    .bind(DID, SAVE_RKEY, SAVE_URL, SAVE_URL)
    .run();
}

function connect(cid?: string) {
  return applySembleConnectionCommit(
    env,
    CURATOR,
    {
      operation: 'create',
      rkey: CONN_RKEY,
      cid,
      record: { source: 'https://elsewhere.net/a', target: SAVE_URL, connectionType: 'RELATED' },
    },
    2000
  );
}

async function call(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, {
      method,
      headers: {
        Cookie: `session_id=${SESSION}`,
        Origin: env.FRONTEND_URL,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const like = (uri = CONN_URI) => call('POST', '/api/saved/connections/like', { uri });
const unlike = (uri = CONN_URI) => call('DELETE', '/api/saved/connections/like', { uri });

async function liked(): Promise<boolean | undefined> {
  const { body } = await call('GET', '/api/saved/connections');
  return body.items[0]?.newest[0]?.liked;
}

function mockPds(fail?: string) {
  const putRecord = vi.fn(async (collection: string, rkey: string, _record: unknown) =>
    fail
      ? { success: false, error: fail, retryable: false }
      : { success: true, data: { uri: `at://${DID}/${collection}/${rkey}`, cid: 'c' } }
  );
  const deleteRecord = vi.fn(async (_collection: string, _rkey: string) => ({
    success: true,
    data: undefined,
  }));
  vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ putRecord, deleteRecord } as never);
  return { putRecord, deleteRecord };
}

describe('liking a connection', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('writes a strongRef like to the poller-kept CID, once', async () => {
    await connect('bafyconnection');
    const { putRecord } = mockPds();
    expect(await liked()).toBe(false);

    expect((await like()).status).toBe(201);
    expect(putRecord).toHaveBeenCalledTimes(1);
    const [collection, , record] = putRecord.mock.calls[0];
    expect(collection).toBe(LIKE_COLLECTION);
    expect(record).toMatchObject({
      $type: LIKE_COLLECTION,
      subject: { uri: CONN_URI, cid: 'bafyconnection' },
    });
    expect(await liked()).toBe(true);

    // A second tap is the same like, not another record.
    expect(await like()).toMatchObject({ status: 200, body: { liked: true } });
    expect(putRecord).toHaveBeenCalledTimes(1);
  });

  it('an unlike deletes the record it wrote', async () => {
    await connect('bafyconnection');
    const { putRecord, deleteRecord } = mockPds();
    await like();
    const rkey = putRecord.mock.calls[0][1];

    expect(await unlike()).toMatchObject({ status: 200, body: { liked: false } });
    expect(deleteRecord).toHaveBeenCalledWith(LIKE_COLLECTION, rkey);
    expect(await liked()).toBe(false);
    // Nothing left to delete.
    expect(await unlike()).toMatchObject({ status: 200, body: { liked: false } });
    expect(deleteRecord).toHaveBeenCalledTimes(1);
  });

  it('looks up the CID of a connection indexed before CIDs were kept', async () => {
    await connect();
    const { putRecord } = mockPds();
    vi.spyOn(didResolver, 'resolvePdsUrl').mockResolvedValue('https://curator.pds');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ uri: CONN_URI, cid: 'bafyfetched', value: {} }))
      );

    expect((await like()).status).toBe(201);
    const asked = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(asked.origin + asked.pathname).toBe(
      'https://curator.pds/xrpc/com.atproto.repo.getRecord'
    );
    expect(asked.searchParams.get('rkey')).toBe(CONN_RKEY);
    expect(putRecord.mock.calls[0][2]).toMatchObject({
      subject: { uri: CONN_URI, cid: 'bafyfetched' },
    });
    const row = await env.DB.prepare('SELECT cid FROM semble_connections WHERE uri = ?')
      .bind(CONN_URI)
      .first<{ cid: string }>();
    expect(row?.cid).toBe('bafyfetched');
  });

  it('tells a gone connection from an unreachable curator', async () => {
    await connect();
    const { putRecord } = mockPds();
    vi.spyOn(didResolver, 'resolvePdsUrl').mockResolvedValue('https://curator.pds');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    fetchSpy.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    expect((await like()).status).toBe(503);
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect((await like()).status).toBe(404);
    expect(putRecord).not.toHaveBeenCalled();
    // Neither left a claim behind.
    expect(await liked()).toBe(false);
  });

  it('only likes connections it has seen', async () => {
    const { putRecord } = mockPds();
    expect((await like()).status).toBe(404);
    expect((await like('not-a-uri')).status).toBe(400);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('a failed write leaves nothing to block a retry', async () => {
    await connect('bafyconnection');
    mockPds('PDS is down');
    expect((await like()).status).toBe(502);
    expect(await liked()).toBe(false);

    const { putRecord } = mockPds();
    expect((await like()).status).toBe(201);
    expect(putRecord).toHaveBeenCalledTimes(1);
  });

  it('sends a session without the like scope to sign in again', async () => {
    await reset(GRANULAR_SCOPES);
    await connect('bafyconnection');
    const { putRecord } = mockPds();
    expect(await like()).toMatchObject({
      status: 403,
      body: { error: 'scope_upgrade_required' },
    });
    expect(putRecord).not.toHaveBeenCalled();
  });
});
