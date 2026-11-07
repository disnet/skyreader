import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { ARTICLE_TEXT_CHARS } from '../src/services/mcp/tools';
import { isValidReturnUrl } from '../src/routes/auth';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const API = 'https://api.skyreader.test';
const REDIRECT_URI = 'https://client.example/callback';

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new IncomingRequest(new URL(url, API), init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

let userSeq = 0;
async function createUser(tier: 'free' | 'supporter' = 'supporter') {
  userSeq++;
  const did = `did:plc:mcp${userSeq}x${Math.random().toString(36).slice(2, 8)}`;
  const handle = `mcp${userSeq}.test`;
  const session = `mcp-session-${userSeq}-${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, created_at) VALUES (?, ?, 'https://pds.test', ?, unixepoch())`
  )
    .bind(did, handle, tier)
    .run();
  await env.DB.prepare(
    `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
     VALUES (?, ?, ?, 'https://pds.test', 'tok', 'rtok', ?, ?)`
  )
    .bind(session, did, handle, JSON.stringify({ kty: 'EC' }), Date.now() + 3_600_000)
    .run();
  return { did, handle, session };
}
type User = Awaited<ReturnType<typeof createUser>>;

async function setTier(user: User, tier: string) {
  await env.DB.prepare('UPDATE users SET tier = ? WHERE did = ?').bind(tier, user.did).run();
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function registerClient(): Promise<string> {
  const response = await call('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.0.0.${userSeq}` },
    body: JSON.stringify({
      client_name: 'Test <b>Agent</b>',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorizeUrl(clientId: string) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  const url = new URL('/oauth/authorize', API);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'mcp:read');
  url.searchParams.set('state', 'st8');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', `${API}/mcp`);
  return { url: url.toString(), verifier };
}

/** Cookies a response set, as a Cookie header for the next request. */
function cookiesFrom(response: Response, existing = ''): string {
  const set = response.headers.getSetCookie().map((c) => c.split(';')[0]);
  return [existing, ...set].filter(Boolean).join('; ');
}

/** The whole dance: register, consent, exchange. Returns an access token for `user`. */
async function connect(
  user: User
): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const clientId = await registerClient();
  const { url, verifier } = await authorizeUrl(clientId);
  const sessionCookie = `session_id=${user.session}`;
  const consent = await call(url, { headers: { Cookie: sessionCookie } });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];

  const approved = await call(url, {
    method: 'POST',
    headers: {
      Cookie: cookiesFrom(consent, sessionCookie),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: API,
      'Sec-Fetch-Site': 'same-origin',
    },
    body: new URLSearchParams({ handle, reader: user.did, decision: 'approve' }).toString(),
  });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('Location')!);
  expect(location.origin + location.pathname).toBe(REDIRECT_URI);
  expect(location.searchParams.get('state')).toBe('st8');
  const code = location.searchParams.get('code')!;

  const token = await call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${API}/mcp`,
    }).toString(),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
  expect(body.scope).toBe('mcp:read');
  return { accessToken: body.access_token, refreshToken: body.refresh_token, clientId };
}

let rpcId = 0;
async function rpc(token: string, method: string, params?: Record<string, unknown>) {
  const response = await call('/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args });
  return body.result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
}

async function save(
  user: User,
  rkey: string,
  title: string,
  savedAt: number,
  content: string | null = null
) {
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, saved_at, source, content)
     VALUES (?, ?, ?, ?, ?, ?, 'url', ?)`
  )
    .bind(
      user.did,
      rkey,
      `at://${user.did}/app.skyreader.feed.saved/${rkey}`,
      `https://blog.example/${rkey}`,
      title,
      savedAt,
      content
    )
    .run();
}

describe('MCP discovery', () => {
  it('challenges an unauthenticated call with its resource metadata', async () => {
    const response = await call('/mcp', { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      `${API}/.well-known/oauth-protected-resource/mcp`
    );
  });

  it('publishes resource and authorization server metadata', async () => {
    const resource = (await (
      await call('/.well-known/oauth-protected-resource/mcp')
    ).json()) as any;
    expect(resource.resource).toBe(`${API}/mcp`);
    expect(resource.scopes_supported).toEqual(['mcp:read']);

    const server = (await (await call('/.well-known/oauth-authorization-server')).json()) as any;
    expect(server.authorization_endpoint).toBe(`${API}/oauth/authorize`);
    expect(server.token_endpoint).toBe(`${API}/oauth/token`);
    expect(server.registration_endpoint).toBe(`${API}/oauth/register`);
  });
});

describe('MCP authorize', () => {
  it('sends a signed-out reader through the usual sign-in, back to the same URL', async () => {
    const { url } = await authorizeUrl(await registerClient());
    const response = await call(url);
    expect(response.status).toBe(302);
    const login = new URL(response.headers.get('Location')!);
    expect(login.origin).toBe(new URL(env.FRONTEND_URL).origin);
    expect(login.pathname).toBe('/auth/login');
    expect(login.searchParams.get('returnUrl')).toBe(url);
  });

  it('refuses a free reader at sign-in with an upgrade page', async () => {
    const user = await createUser('free');
    const { url } = await authorizeUrl(await registerClient());
    const response = await call(url, { headers: { Cookie: `session_id=${user.session}` } });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Supporter feature');
  });

  it('escapes the client’s self-chosen name and can’t be framed', async () => {
    const user = await createUser();
    const { url } = await authorizeUrl(await registerClient());
    const response = await call(url, { headers: { Cookie: `session_id=${user.session}` } });
    const html = await response.text();
    expect(html).toContain('Test &lt;b&gt;Agent&lt;/b&gt;');
    expect(html).not.toContain('<b>Agent</b>');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('sends Cancel back to the app as access_denied', async () => {
    const user = await createUser();
    const { url } = await authorizeUrl(await registerClient());
    const sessionCookie = `session_id=${user.session}`;
    const consent = await call(url, { headers: { Cookie: sessionCookie } });
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1];
    const denied = await call(url, {
      method: 'POST',
      headers: {
        Cookie: cookiesFrom(consent, sessionCookie),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ handle, reader: user.did, decision: 'deny' }).toString(),
    });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get('Location')!).searchParams.get('error')).toBe(
      'access_denied'
    );
  });

  it('shows a bad request on its own page, never redirecting to the app', async () => {
    const clientId = await registerClient();
    const { url } = await authorizeUrl(clientId);
    const bad = new URL(url);
    bad.searchParams.set('response_type', 'token');
    const response = await call(bad.toString());
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('starts over when the browser switched accounts since the page was shown', async () => {
    const user = await createUser();
    const other = await createUser();
    const { url } = await authorizeUrl(await registerClient());
    const consent = await call(url, { headers: { Cookie: `session_id=${user.session}` } });
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1];
    const switched = await call(url, {
      method: 'POST',
      headers: {
        Cookie: cookiesFrom(consent, `session_id=${other.session}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ handle, reader: user.did, decision: 'approve' }).toString(),
    });
    expect(switched.status).toBe(409);
  });

  it('won’t take a consent form without the browser’s binding cookie', async () => {
    const user = await createUser();
    const { url } = await authorizeUrl(await registerClient());
    const sessionCookie = `session_id=${user.session}`;
    const consent = await call(url, { headers: { Cookie: sessionCookie } });
    const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())![1];
    const forged = await call(url, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle, reader: user.did, decision: 'approve' }).toString(),
    });
    expect(forged.status).toBe(400);
  });
});

describe('MCP server', () => {
  it('connects end to end and answers initialize and tools/list', async () => {
    const user = await createUser();
    const { accessToken } = await connect(user);

    const init = await rpc(accessToken, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(init.body.result.serverInfo.name).toBe('skyreader');

    const list = await rpc(accessToken, 'tools/list');
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'search',
      'list_saved',
      'get_saved_article',
      'list_highlights',
      'list_collections',
    ]);
    for (const t of list.body.result.tools) expect(t.annotations.readOnlyHint).toBe(true);
  });

  it('offers its newest protocol version to a client asking for an unknown one', async () => {
    const { accessToken } = await connect(await createUser());
    const init = await rpc(accessToken, 'initialize', { protocolVersion: '1999-01-01' });
    expect(init.body.result.protocolVersion).toBe('2025-11-25');
  });

  it('acknowledges notifications without a body, and refuses GET', async () => {
    const { accessToken } = await connect(await createUser());
    const note = await call('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(note.status).toBe(202);
    const get = await call('/mcp', { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(get.status).toBe(405);
  });

  it('lists and reads the reader’s saves, and only theirs', async () => {
    const user = await createUser();
    const other = await createUser();
    await save(user, 'aaaaaaaaaaaaa', 'Older', 1_000, '<p>Old words</p>');
    await save(
      user,
      'bbbbbbbbbbbbb',
      'Newer',
      2_000,
      `<p>${'word '.repeat(ARTICLE_TEXT_CHARS / 5 + 400)}</p>`
    );
    await save(other, 'ccccccccccccc', 'Not yours', 3_000, '<p>secret</p>');
    const { accessToken } = await connect(user);

    const listed = await tool(accessToken, 'list_saved', { limit: 1 });
    expect(listed.isError).toBeUndefined();
    expect(listed.structuredContent.saved.map((s: { title: string }) => s.title)).toEqual([
      'Newer',
    ]);
    expect(listed.structuredContent.nextOffset).toBe(1);
    expect(JSON.parse(listed.content[0].text)).toEqual(listed.structuredContent);

    const next = await tool(accessToken, 'list_saved', { limit: 1, offset: 1 });
    expect(next.structuredContent.saved.map((s: { title: string }) => s.title)).toEqual(['Older']);

    const read = await tool(accessToken, 'get_saved_article', { rkey: 'aaaaaaaaaaaaa' });
    expect(read.structuredContent.text).toBe('Old words');
    expect(read.structuredContent.truncated).toBe(false);

    const long = await tool(accessToken, 'get_saved_article', { rkey: 'bbbbbbbbbbbbb' });
    expect(long.structuredContent.text.length).toBeLessThanOrEqual(ARTICLE_TEXT_CHARS);
    expect(long.structuredContent.truncated).toBe(true);

    const theirs = await tool(accessToken, 'get_saved_article', { rkey: 'ccccccccccccc' });
    expect(theirs.isError).toBe(true);
  });

  it('lists Shelf collections and the saves in one', async () => {
    const user = await createUser();
    await save(user, 'ddddddddddddd', 'In shelf', 1_000);
    await save(user, 'eeeeeeeeeeeee', 'Loose', 2_000);
    await env.DB.prepare(
      `INSERT INTO shelf_collections (id, user_did, name, position, created_at, updated_at) VALUES ('col1', ?, 'Essays', 0, 1, 1)`
    )
      .bind(user.did)
      .run();
    await env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at) VALUES (?, 'col1', 'ddddddddddddd', 1, 5)`
    )
      .bind(user.did)
      .run();
    const { accessToken } = await connect(user);

    const collections = await tool(accessToken, 'list_collections');
    expect(collections.structuredContent.collections).toEqual([{ id: 'col1', name: 'Essays' }]);
    const inShelf = await tool(accessToken, 'list_saved', { collectionId: 'col1' });
    expect(inShelf.structuredContent.saved.map((s: { title: string }) => s.title)).toEqual([
      'In shelf',
    ]);
  });

  it('returns highlights with their notes', async () => {
    const user = await createUser();
    await save(user, 'fffffffffffff', 'Marked up', 1_000);
    await env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
       VALUES (?, 'saved:fffffffffffff', 'article', 'highlights', ?, 'hl1', 100, 100, 100000)`
    )
      .bind(
        user.did,
        JSON.stringify({
          highlights: [
            {
              id: 'h1',
              selector: { type: 'TextQuoteSelector', exact: 'a key line' },
              createdAt: 10,
              note: 'why it matters',
            },
          ],
        })
      )
      .run();
    const { accessToken } = await connect(user);

    const result = await tool(accessToken, 'list_highlights');
    expect(result.structuredContent.pages).toHaveLength(1);
    expect(result.structuredContent.pages[0]).toMatchObject({
      title: 'Marked up',
      rkey: 'fffffffffffff',
      highlights: [{ text: 'a key line', note: 'why it matters' }],
    });
  });

  it('gives no rkey for highlights whose save is gone', async () => {
    const user = await createUser();
    await env.DB.prepare(
      `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
       VALUES (?, 'saved:zzzzzzzzzzzzz', 'article', 'highlights', ?, 'hl2', 100, 100, 100000)`
    )
      .bind(
        user.did,
        JSON.stringify({
          highlights: [
            { id: 'h1', selector: { type: 'TextQuoteSelector', exact: 'orphan' }, createdAt: 10 },
          ],
        })
      )
      .run();
    const { accessToken } = await connect(user);
    const result = await tool(accessToken, 'list_highlights');
    expect(result.structuredContent.pages[0].rkey).toBeNull();
  });

  it('tells the model when a tool’s arguments are wrong', async () => {
    const { accessToken } = await connect(await createUser());
    const bad = await tool(accessToken, 'list_saved', { limit: 'lots' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('limit');
    const unknown = await rpc(accessToken, 'tools/call', {
      name: 'delete_everything',
      arguments: {},
    });
    expect(unknown.body.error.code).toBe(-32602);
  });

  it('stops a reader whose plan lapsed, without revoking anything', async () => {
    const user = await createUser();
    const { accessToken } = await connect(user);
    await setTier(user, 'free');
    const result = await tool(accessToken, 'list_collections');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Supporter');
    await setTier(user, 'supporter');
    expect((await tool(accessToken, 'list_collections')).isError).toBeUndefined();
  });

  it('accepts its own tokens only: a Skyreader session id is not one', async () => {
    const user = await createUser();
    const response = await call('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('issues tokens the rest of the API doesn’t accept', async () => {
    const { accessToken } = await connect(await createUser());
    const response = await call('/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(401);
  });
});

describe('MCP connections in Settings', () => {
  const settings = (user: User, path = '', method = 'GET') =>
    call(`/api/mcp/connections${path}`, {
      method,
      headers: { Cookie: `session_id=${user.session}`, Origin: env.FRONTEND_URL },
    });

  it('lists the reader’s connected apps, and disconnecting one ends its access', async () => {
    const user = await createUser();
    const other = await createUser();
    const { accessToken } = await connect(user);
    await connect(other);

    const listed = (await (await settings(user)).json()) as {
      serverUrl: string;
      connections: { id: string; name: string; redirectHost: string }[];
    };
    expect(listed.serverUrl).toBe(`${API}/mcp`);
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]).toMatchObject({
      name: 'Test <b>Agent</b>',
      redirectHost: 'client.example',
    });

    const otherGrant = ((await (await settings(other)).json()) as { connections: { id: string }[] })
      .connections[0].id;
    expect((await settings(user, `/${encodeURIComponent(otherGrant)}`, 'DELETE')).status).toBe(404);

    const id = listed.connections[0].id;
    expect((await settings(user, `/${encodeURIComponent(id)}`, 'DELETE')).status).toBe(200);
    expect((await rpc(accessToken, 'tools/list')).status).toBe(401);
    expect(
      ((await (await settings(user)).json()) as { connections: unknown[] }).connections
    ).toEqual([]);
  });
});

describe('signing in to authorize', () => {
  const allowed = ['https://skyreader.app'];
  it('may return to the consent page on the API’s own origin, and nowhere else there', () => {
    expect(isValidReturnUrl(`${API}/oauth/authorize?client_id=x`, allowed, API)).toBe(true);
    expect(isValidReturnUrl(`${API}/api/auth/me`, allowed, API)).toBe(false);
    expect(isValidReturnUrl('https://evil.example/oauth/authorize', allowed, API)).toBe(false);
    expect(isValidReturnUrl(`${API}/oauth/authorize`, allowed)).toBe(false);
  });
});
