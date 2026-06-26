import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import * as linkblogSync from '../src/services/linkblog-sync';
import * as didResolver from '../src/utils/did-resolver';
import { GRANULAR_SCOPES, LINKBLOG_SCOPES } from '../src/config/scopes';
import { SKYREADER_APP_DID } from '../src/config/identity';
import { genKeypair, mintServiceJwt } from './helpers/jwt';

// Route-level coverage for the AT Intents XRPC service endpoints
// (/xrpc/app.skyreader.feed.save, /xrpc/app.skyreader.feed.subscribe). These pin the
// XRPC wire contract: subject + inputs arrive as query-string params, the same Skyreader
// session auth is reused, and errors come back as { error: <Name>, message }.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:xrpctest';
const SESSION = 'sess-xrpc';

async function setupUser(grantedScopes: string) {
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'xr.bsky.social', 'https://pds.test', 'free', unixepoch())
     ON CONFLICT(did) DO NOTHING`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'xr.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, grantedScopes)
    .run();
}

async function reset(grantedScopes = GRANULAR_SCOPES) {
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM subscriptions_cache WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await setupUser(grantedScopes);
}

// XRPC procedures carry subject + inputs in the query string, not a body.
function xrpc(
  path: string,
  params: Record<string, string>,
  opts: { auth?: boolean; method?: string; bearer?: string } = {}
) {
  const { auth = true, method = 'POST', bearer } = opts;
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { Origin: env.FRONTEND_URL };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else if (auth) headers.Cookie = `session_id=${SESSION}`;
  return new IncomingRequest(`http://localhost${path}?${qs}`, { method, headers });
}

function serviceJwt(opts: {
  privateKey: Uint8Array;
  iss: string;
  lxm: string;
  aud?: string;
  expInSec?: number;
}) {
  return mintServiceJwt({
    curve: 'k256',
    privateKey: opts.privateKey,
    claims: {
      iss: opts.iss,
      aud: opts.aud ?? SKYREADER_APP_DID,
      lxm: opts.lxm,
      exp: Math.floor(Date.now() / 1000) + (opts.expInSec ?? 60),
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

describe('XRPC /xrpc/app.skyreader.feed.save', () => {
  beforeEach(() => reset());

  it('saves an article from the subject URL and returns success', async () => {
    const { status } = await call(
      xrpc('/xrpc/app.skyreader.feed.save', {
        subject: 'https://example.com/post',
        title: 'Hello',
      })
    );
    expect(status).toBeLessThan(300);

    const row = await env.DB.prepare('SELECT url, title FROM saved_articles WHERE user_did = ?')
      .bind(DID)
      .first<{ url: string; title: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.url).toBe('https://example.com/post');
    expect(row!.title).toBe('Hello');
  });

  it('rejects a missing subject with XRPC InvalidRequest (400)', async () => {
    const { status, body } = await call(xrpc('/xrpc/app.skyreader.feed.save', {}));
    expect(status).toBe(400);
    expect(body.error).toBe('InvalidRequest');
    expect(typeof body.message).toBe('string');
  });

  it('rejects an unauthenticated call with XRPC AuthenticationRequired (401)', async () => {
    const { status, body } = await call(
      xrpc(
        '/xrpc/app.skyreader.feed.save',
        { subject: 'https://example.com/post' },
        { auth: false }
      )
    );
    expect(status).toBe(401);
    expect(body.error).toBe('AuthenticationRequired');
  });

  it('rejects GET (this is a POST procedure) with MethodNotImplemented (405)', async () => {
    const { status, body } = await call(
      xrpc(
        '/xrpc/app.skyreader.feed.save',
        { subject: 'https://example.com/post' },
        { method: 'GET' }
      )
    );
    expect(status).toBe(405);
    expect(body.error).toBe('MethodNotImplemented');
  });
});

describe('XRPC /xrpc/app.skyreader.feed.subscribe', () => {
  beforeEach(() => reset());

  it('subscribes to the subject feed URL and stores it in D1', async () => {
    const { status } = await call(
      xrpc('/xrpc/app.skyreader.feed.subscribe', {
        subject: 'https://example.com/feed.xml',
        category: 'tech',
      })
    );
    expect(status).toBeLessThan(300);

    const row = await env.DB.prepare(
      'SELECT feed_url, category FROM subscriptions_cache WHERE user_did = ?'
    )
      .bind(DID)
      .first<{ feed_url: string; category: string | null }>();
    expect(row).not.toBeNull();
    expect(row!.feed_url).toBe('https://example.com/feed.xml');
    expect(row!.category).toBe('tech');
  });

  it('rejects a missing subject with XRPC InvalidRequest (400)', async () => {
    const { status, body } = await call(xrpc('/xrpc/app.skyreader.feed.subscribe', {}));
    expect(status).toBe(400);
    expect(body.error).toBe('InvalidRequest');
  });
});

describe('XRPC /xrpc/app.skyreader.linkblog.share', () => {
  const LINKBLOG_SESSION_SCOPES = `${GRANULAR_SCOPES} ${LINKBLOG_SCOPES.join(' ')}`;

  beforeEach(() => reset(LINKBLOG_SESSION_SCOPES));
  afterEach(() => vi.restoreAllMocks());

  it('shares the subject URL via the linkblog (publication-linking handled server-side)', async () => {
    // The underlying write touches the PDS — stub it so the test stays hermetic. The
    // point is that the XRPC wrapper delegates with the right inputs, not the PDS write.
    const spy = vi
      .spyOn(linkblogSync, 'writeLinkblogShare')
      .mockResolvedValue({ success: true, data: { uri: 'at://x/doc', cid: 'cid1' } } as any);

    const { status } = await call(
      xrpc('/xrpc/app.skyreader.linkblog.share', {
        subject: 'https://example.com/post',
        title: 'A title',
        note: 'worth a read',
      })
    );
    expect(status).toBeLessThan(300);

    expect(spy).toHaveBeenCalledTimes(1);
    const [, , rkey, input] = spy.mock.calls[0];
    expect(rkey).toMatch(/^[a-z0-9]{13,}$/); // freshly minted TID
    expect(input.articleUrl).toBe('https://example.com/post');
    expect(input.articleTitle).toBe('A title');
    expect(input.note).toBe('worth a read');
  });

  it('rejects a missing subject with XRPC InvalidRequest (400)', async () => {
    const { status, body } = await call(xrpc('/xrpc/app.skyreader.linkblog.share', {}));
    expect(status).toBe(400);
    expect(body.error).toBe('InvalidRequest');
  });

  it('rejects an unauthenticated call with XRPC AuthenticationRequired (401)', async () => {
    const { status, body } = await call(
      xrpc(
        '/xrpc/app.skyreader.linkblog.share',
        { subject: 'https://example.com/post' },
        { auth: false }
      )
    );
    expect(status).toBe(401);
    expect(body.error).toBe('AuthenticationRequired');
  });
});

describe('XRPC service auth (atproto inter-service JWT)', () => {
  beforeEach(() => reset()); // user + stored session for DID, GRANULAR scopes
  afterEach(() => vi.restoreAllMocks());

  it('verifies a service-auth JWT, maps the DID to the stored session, and saves', async () => {
    const kp = genKeypair('k256');
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    const jwt = await serviceJwt({ privateKey: kp.sk, iss: DID, lxm: 'app.skyreader.feed.save' });

    const { status } = await call(
      xrpc(
        '/xrpc/app.skyreader.feed.save',
        { subject: 'https://svc.example/post' },
        { auth: false, bearer: jwt }
      )
    );
    expect(status).toBeLessThan(300);

    const row = await env.DB.prepare('SELECT url FROM saved_articles WHERE user_did = ?')
      .bind(DID)
      .first<{ url: string }>();
    expect(row?.url).toBe('https://svc.example/post');
  });

  it('rejects a valid JWT when the user has no stored Skyreader session (401)', async () => {
    const kp = genKeypair('k256');
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    const jwt = await serviceJwt({
      privateKey: kp.sk,
      iss: 'did:plc:nosessionuser',
      lxm: 'app.skyreader.feed.save',
    });

    const { status, body } = await call(
      xrpc(
        '/xrpc/app.skyreader.feed.save',
        { subject: 'https://svc.example/post' },
        { auth: false, bearer: jwt }
      )
    );
    expect(status).toBe(401);
    expect(body.error).toBe('AuthenticationRequired');
    expect(body.message).toMatch(/no active skyreader session/i);
  });

  it('rejects a JWT scoped to a different method (lxm mismatch)', async () => {
    const kp = genKeypair('k256');
    vi.spyOn(didResolver, 'resolveAtprotoSigningKey').mockResolvedValue(kp.multibase);
    // A token minted for linkblog.share presented to the save endpoint.
    const jwt = await serviceJwt({
      privateKey: kp.sk,
      iss: DID,
      lxm: 'app.skyreader.linkblog.share',
    });

    const { status, body } = await call(
      xrpc(
        '/xrpc/app.skyreader.feed.save',
        { subject: 'https://svc.example/post' },
        { auth: false, bearer: jwt }
      )
    );
    expect(status).toBe(401);
    expect(body.error).toBe('AuthenticationRequired');
    expect(body.message).toMatch(/method/i);
  });
});
