import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as pdsClient from '../src/services/pds-client';
import { GRANULAR_SCOPES, RECOMMEND_SCOPES, STANDARD_RECOMMEND_SCOPES } from '../src/config/scopes';
import { RECOMMEND_COLLECTION, STANDARD_RECOMMEND_COLLECTION } from '../src/routes/recommends';

// Recommends — one record per (reader, article) in the reader's own repo, plus a
// standard.site copy when the article is a standard.site document and the session
// can write one. What's pinned: the record shapes, idempotency (the D1 claim), and
// that a failed PDS write leaves nothing behind to block a retry.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:recommender';
const SESSION = 'sess-recommends';
const ARTICLE = 'https://example.com/posts/worth-reading';
const DOCUMENT = 'at://did:plc:author/site.standard.document/3kdoc';
const BASE_SCOPES = `${GRANULAR_SCOPES} ${RECOMMEND_SCOPES.join(' ')}`;
const WITH_STANDARD = `${BASE_SCOPES} ${STANDARD_RECOMMEND_SCOPES.join(' ')}`;

async function reset(grantedScopes = WITH_STANDARD) {
  await env.DB.prepare('DELETE FROM recommendations WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'rec.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'rec.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
    .run();
}

function request(method: string, body?: unknown) {
  return new IncomingRequest('http://localhost/api/recommends', {
    method,
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(req: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A PDS whose writes answer as given (success by default), per collection. */
function mockPds(fail: Partial<Record<string, string>> = {}) {
  const putRecord = vi.fn(async (collection: string, rkey: string, _record: unknown) =>
    fail[collection]
      ? { success: false, error: fail[collection], retryable: false }
      : { success: true, data: { uri: `at://${DID}/${collection}/${rkey}`, cid: 'c' } }
  );
  const deleteRecord = vi.fn(async (_collection: string, _rkey: string) => ({
    success: true,
    data: undefined,
  }));
  vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ putRecord, deleteRecord } as never);
  return { putRecord, deleteRecord };
}

async function rows() {
  const res = await env.DB.prepare(
    'SELECT url, rkey, document_uri, standard_rkey FROM recommendations WHERE did = ?'
  )
    .bind(DID)
    .all<{
      url: string;
      rkey: string;
      document_uri: string | null;
      standard_rkey: string | null;
    }>();
  return res.results;
}

describe('POST /api/recommends', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('writes one recommend record keyed by the article URL', async () => {
    const { putRecord } = mockPds();
    const { status, body } = await call(request('POST', { url: ARTICLE, title: 'Worth it' }));
    expect(status).toBe(201);
    expect(body.recommended).toBe(true);
    expect(putRecord).toHaveBeenCalledTimes(1);
    const [collection, rkey, record] = putRecord.mock.calls[0];
    expect(collection).toBe(RECOMMEND_COLLECTION);
    expect(record).toMatchObject({ $type: RECOMMEND_COLLECTION, subject: ARTICLE });
    expect(record).not.toHaveProperty('document');
    expect(body.uri).toBe(`at://${DID}/${RECOMMEND_COLLECTION}/${rkey}`);
    expect(await rows()).toEqual([{ url: ARTICLE, rkey, document_uri: null, standard_rkey: null }]);
  });

  it('also writes a site.standard.graph.recommend for a standard.site document', async () => {
    const { putRecord } = mockPds();
    const { status } = await call(request('POST', { url: ARTICLE, documentUri: DOCUMENT }));
    expect(status).toBe(201);
    expect(putRecord).toHaveBeenCalledTimes(2);
    expect(putRecord.mock.calls[0][2]).toMatchObject({ subject: ARTICLE, document: DOCUMENT });
    const [collection, standardRkey, record] = putRecord.mock.calls[1];
    expect(collection).toBe(STANDARD_RECOMMEND_COLLECTION);
    expect(record).toMatchObject({ $type: STANDARD_RECOMMEND_COLLECTION, document: DOCUMENT });
    expect((await rows())[0].standard_rkey).toBe(standardRkey);
  });

  it('skips the standard.site copy for a session without its scope', async () => {
    await reset(BASE_SCOPES);
    const { putRecord } = mockPds();
    const { status } = await call(request('POST', { url: ARTICLE, documentUri: DOCUMENT }));
    expect(status).toBe(201);
    expect(putRecord).toHaveBeenCalledTimes(1);
    expect(putRecord.mock.calls[0][0]).toBe(RECOMMEND_COLLECTION);
  });

  it('keeps the recommend when only the standard.site copy fails', async () => {
    mockPds({ [STANDARD_RECOMMEND_COLLECTION]: 'nope' });
    const { status } = await call(request('POST', { url: ARTICLE, documentUri: DOCUMENT }));
    expect(status).toBe(201);
    const [row] = await rows();
    expect(row.standard_rkey).toBeNull();
  });

  it('is idempotent across URL variants: an existing recommend is the answer', async () => {
    const { putRecord } = mockPds();
    await call(request('POST', { url: ARTICLE }));
    const { status, body } = await call(request('POST', { url: `${ARTICLE}/?utm_source=x` }));
    expect(status).toBe(200);
    expect(body.recommended).toBe(true);
    expect(putRecord).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it('releases the claim when the PDS write fails, so a retry can write', async () => {
    mockPds({ [RECOMMEND_COLLECTION]: 'pds down' });
    const { status } = await call(request('POST', { url: ARTICLE }));
    expect(status).toBe(502);
    expect(await rows()).toEqual([]);
  });

  it('asks for a re-grant when the session lacks the recommend scope', async () => {
    await reset(GRANULAR_SCOPES);
    const { putRecord } = mockPds();
    const { status, body } = await call(request('POST', { url: ARTICLE }));
    expect(status).toBe(403);
    expect(body.error).toBe('scope_upgrade_required');
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('rejects a non-http URL and a documentUri that is not a standard.site document', async () => {
    mockPds();
    expect((await call(request('POST', { url: 'javascript:alert(1)' }))).status).toBe(400);
    expect(
      (
        await call(
          request('POST', { url: ARTICLE, documentUri: 'at://did:plc:x/app.bsky.feed.post/1' })
        )
      ).status
    ).toBe(400);
    expect(await rows()).toEqual([]);
  });
});

describe('DELETE /api/recommends', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('deletes both records and the row', async () => {
    const { putRecord, deleteRecord } = mockPds();
    await call(request('POST', { url: ARTICLE, documentUri: DOCUMENT }));
    const ownRkey = putRecord.mock.calls[0][1];
    const standardRkey = putRecord.mock.calls[1][1];

    const { status, body } = await call(request('DELETE', { url: ARTICLE }));
    expect(status).toBe(200);
    expect(body).toEqual({ recommended: false });
    expect(deleteRecord.mock.calls).toEqual([
      [STANDARD_RECOMMEND_COLLECTION, standardRkey],
      [RECOMMEND_COLLECTION, ownRkey],
    ]);
    expect(await rows()).toEqual([]);
  });

  it('is a no-op for an article never recommended', async () => {
    const { deleteRecord } = mockPds();
    const { status, body } = await call(request('DELETE', { url: ARTICLE }));
    expect(status).toBe(200);
    expect(body).toEqual({ recommended: false });
    expect(deleteRecord).not.toHaveBeenCalled();
  });
});

describe('GET /api/recommends', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it("lists the reader's recommends", async () => {
    mockPds();
    await call(request('POST', { url: ARTICLE, title: 'Worth it', documentUri: DOCUMENT }));
    const { status, body } = await call(request('GET'));
    expect(status).toBe(200);
    expect(body.recommends).toHaveLength(1);
    expect(body.recommends[0]).toMatchObject({
      url: ARTICLE,
      title: 'Worth it',
      documentUri: DOCUMENT,
    });
  });
});
