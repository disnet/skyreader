import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { GRANULAR_SCOPES } from '../src/config/scopes';
import * as mirror from '../src/services/spaces/mirror';

// Verification criteria 5 and 6 of the atproto Spaces spike:
//   - with SPACES_SAVES_ENABLED unset, no spaces code runs at all;
//   - with it set but the space unreachable, a save still succeeds and D1 still
//     holds the row (the mirror is best-effort, D1 is canonical).

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const DID = 'did:plc:spacesmirror';
const SESSION = 'sess-spaces-mirror';

async function reset() {
  await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM sessions WHERE did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM user_settings WHERE user_did = ?').bind(DID).run();
  await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, 'sm.bsky.social', 'https://pds.test', 'free', unixepoch())`
  )
    .bind(DID)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
     VALUES (?, ?, 'sm.bsky.social', 'https://pds.test', 'tok', 'rtok', ?, ?, ?)`
  )
    .bind(SESSION, DID, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000, GRANULAR_SCOPES)
    .run();
  mirror.clearSpaceCapabilityCache();
}

function saveRequest(body: unknown) {
  return new IncomingRequest('http://localhost/api/saved', {
    method: 'POST',
    headers: {
      Cookie: `session_id=${SESSION}`,
      Origin: env.FRONTEND_URL,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function call(req: Request, overrides: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...overrides } as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function spacesWarnings(warn: { mock: { calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.filter((args) => String(args[0]).startsWith('[spaces]'));
}

const FEED_SAVE = {
  url: 'https://example.com/spaces-article',
  rkey: '3lspacesaaaaa',
  source: 'feed',
  itemGuid: 'guid-spaces-1',
  title: 'Spaces article',
  wordCount: 400,
};

describe('spaces mirror — flag gate', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('does not touch the space path at all when the flag is unset', async () => {
    // env from wrangler.toml has no SPACES_SAVES_ENABLED, which is the
    // production shape: the var exists only in .dev.vars.
    expect((env as { SPACES_SAVES_ENABLED?: string }).SPACES_SAVES_ENABLED).toBeUndefined();
    expect(mirror.spacesSavesEnabled(env)).toBe(false);

    // The mirror's only observable trace is its own warning, so the absence of
    // one is the assertion. (Spying on the module's exports wouldn't prove
    // anything: saved.ts holds a direct binding to mirrorSaveToSpace.)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status } = await call(saveRequest(FEED_SAVE));

    expect(status).toBe(200);
    expect(spacesWarnings(warn)).toEqual([]);

    const row = await env.DB.prepare('SELECT rkey FROM saved_articles WHERE user_did = ?')
      .bind(DID)
      .first<{ rkey: string }>();
    expect(row?.rkey).toBe(FEED_SAVE.rkey);
  });

  it('does reach the space path once the flag is on (the control for the test above)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await call(saveRequest(FEED_SAVE), { SPACES_SAVES_ENABLED: 'true' });
    expect(spacesWarnings(warn).length).toBeGreaterThan(0);
  });

  it('leaves the dev read-back route unmounted when the flag is unset', async () => {
    const res = await call(
      new IncomingRequest('http://localhost/api/dev/spaces/saved-diff', {
        headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
      })
    );
    expect(res.status).toBe(404);
  });
});

describe('spaces mirror — best effort with the flag on', () => {
  beforeEach(() => reset());
  afterEach(() => vi.restoreAllMocks());

  it('still saves, and keeps the D1 row, when the space is unreachable', async () => {
    // The seeded session carries a placeholder DPoP key, so every PDS call fails
    // closed — the same shape as a PDS that has never heard of Spaces.
    const { status, body } = await call(saveRequest(FEED_SAVE), {
      SPACES_SAVES_ENABLED: 'true',
    });

    expect(status).toBe(200);
    expect(body.rkey).toBe(FEED_SAVE.rkey);

    const row = await env.DB.prepare(
      'SELECT rkey, title FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(DID, FEED_SAVE.rkey)
      .first<{ rkey: string; title: string }>();
    expect(row?.title).toBe('Spaces article');
  });

  it('still deletes, and removes the D1 row, when the space is unreachable', async () => {
    await call(saveRequest(FEED_SAVE), { SPACES_SAVES_ENABLED: 'true' });

    const res = await call(
      new IncomingRequest(`http://localhost/api/saved/${FEED_SAVE.rkey}`, {
        method: 'DELETE',
        headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
      }),
      { SPACES_SAVES_ENABLED: 'true' }
    );

    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT rkey FROM saved_articles WHERE user_did = ?')
      .bind(DID)
      .first();
    expect(row).toBeNull();
  });

  it('reports spaces_unavailable from the diff route rather than a clean empty diff', async () => {
    const res = await call(
      new IncomingRequest('http://localhost/api/dev/spaces/saved-diff', {
        headers: { Cookie: `session_id=${SESSION}`, Origin: env.FRONTEND_URL },
      }),
      { SPACES_SAVES_ENABLED: 'true' }
    );

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('spaces_unavailable');
  });

  it('caches the capability verdict so an ordinary PDS is probed once, not per save', async () => {
    const session = {
      did: DID,
      handle: 'sm.bsky.social',
      pdsUrl: 'https://pds.test',
      accessToken: 'tok',
      refreshToken: 'rtok',
      dpopPrivateKey: JSON.stringify({ kty: 'EC' }),
      expiresAt: Date.now() + 3_600_000,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await mirror.ensureSavedSpace(session)).toBeNull();
    const afterFirst = fetchSpy.mock.calls.length;
    expect(await mirror.ensureSavedSpace(session)).toBeNull();
    expect(fetchSpy.mock.calls.length).toBe(afterFirst);
  });
});
