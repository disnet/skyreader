import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as pdsClient from '../src/services/pds-client';
import { ALL_POSSIBLE_SCOPES } from '../src/config/scopes';

// Saving to Semble or Margin writes a record to the reader's own repo. The
// session's recorded scopes can pass the gate while the PDS still refuses the
// write, and the client decides whether to queue from the status we answer —
// so a scope denial has to come back as the permission ask, a transient failure
// as retryable, and a refusal as neither.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:integrationsave';
const SESSION = 'sess-integration-save';

async function reset() {
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at)
     VALUES (?, 'save.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'save.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, ALL_POSSIBLE_SCOPES)
    .run();
}

function fakePds(result: unknown) {
  const putRecord = vi.fn(async () => result);
  vi.spyOn(pdsClient, 'createPDSClient').mockReturnValue({ putRecord } as never);
  return putRecord;
}

const ROUTES = [
  ['semble', 'http://localhost/api/integrations/semble/cards'],
  ['margin', 'http://localhost/api/integrations/margin/bookmarks'],
] as const;

async function save(url: string): Promise<{ status: number; body: any }> {
  const req = new IncomingRequest(url, {
    method: 'POST',
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: 'https://example.test/piece', title: 'A Piece' }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe.each(ROUTES)('saving to %s when the PDS write fails', (integration, url) => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  it('asks for permission when the PDS denies the scope', async () => {
    fakePds({
      success: false,
      error: 'Missing required scope "repo:x"',
      code: 'InsufficientScope',
      status: 403,
      retryable: false,
    });
    const { status, body } = await save(url);
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'scope_upgrade_required', feature: integration });
  });

  it('answers 503 for a failure a retry can fix', async () => {
    fakePds({ success: false, error: 'upstream timeout', retryable: true });
    expect((await save(url)).status).toBe(503);
  });

  it('answers 502 for a refusal a retry cannot fix', async () => {
    fakePds({ success: false, error: 'InvalidRecord', status: 400, retryable: false });
    expect((await save(url)).status).toBe(502);
  });
});
