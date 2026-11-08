import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { ARTICLE_TEXT_CHARS } from '../src/services/mcp/tools';
import { isValidReturnUrl } from '../src/routes/auth';
import { collectExport } from '../src/services/export/collect';

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
    expect(listed.structuredContent.hasMore).toBe(true);
    expect(listed.structuredContent.total).toBe(2);
    expect(JSON.parse(listed.content[0].text)).toEqual(listed.structuredContent);

    const next = await tool(accessToken, 'list_saved', {
      limit: 1,
      cursor: listed.structuredContent.nextCursor,
    });
    expect(next.structuredContent.saved.map((s: { title: string }) => s.title)).toEqual(['Older']);
    // A full last page still says it's the last.
    expect(next.structuredContent.hasMore).toBe(false);
    expect(next.structuredContent.nextCursor).toBeUndefined();

    const read = await tool(accessToken, 'get_saved_article', { rkey: 'aaaaaaaaaaaaa' });
    expect(read.structuredContent.text).toBe('Old words');
    expect(read.structuredContent.truncated).toBe(false);

    const long = await tool(accessToken, 'get_saved_article', { rkey: 'bbbbbbbbbbbbb' });
    expect(long.structuredContent.text.length).toBeLessThanOrEqual(ARTICLE_TEXT_CHARS);
    expect(long.structuredContent.truncated).toBe(true);
    // The chunks put back together are the whole text, with no word split between two.
    let whole = long.structuredContent.text;
    expect(whole.endsWith(' ')).toBe(true);
    let chunk = long.structuredContent;
    while (chunk.truncated) {
      chunk = (
        await tool(accessToken, 'get_saved_article', {
          rkey: 'bbbbbbbbbbbbb',
          fromChar: chunk.nextChar,
        })
      ).structuredContent;
      whole += chunk.text;
    }
    expect(whole).toBe(`${'word '.repeat(ARTICLE_TEXT_CHARS / 5 + 400)}`.trim());
    expect(chunk.totalChars).toBe(whole.length);
    const past = await tool(accessToken, 'get_saved_article', {
      rkey: 'bbbbbbbbbbbbb',
      fromChar: whole.length,
    });
    expect(past.isError).toBe(true);

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
    // An item whose save is gone isn't listed, so it isn't counted either.
    await env.DB.prepare(
      `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at) VALUES (?, 'col1', 'zzzzzzzzzzzzz', 2, 6)`
    )
      .bind(user.did)
      .run();
    await env.DB.prepare(
      `INSERT INTO shelf_collections (id, user_did, name, position, created_at, updated_at) VALUES ('col2', ?, 'Empty', 1, 2, 2)`
    )
      .bind(user.did)
      .run();
    const { accessToken } = await connect(user);

    const collections = await tool(accessToken, 'list_collections');
    expect(collections.structuredContent).toEqual({
      collections: [
        { id: 'col1', name: 'Essays', itemCount: 1 },
        { id: 'col2', name: 'Empty', itemCount: 0 },
      ],
      totalSaved: 2,
    });
    const inShelf = await tool(accessToken, 'list_saved', { collectionId: 'col1' });
    expect(inShelf.structuredContent.saved.map((s: { title: string }) => s.title)).toEqual([
      'In shelf',
    ]);
    expect(inShelf.structuredContent.total).toBe(1);
  });

  it('pages every save by cursor, past ties and through a collection, and filters by date', async () => {
    const user = await createUser();
    const rkeys = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(13));
    // Two saves share a time, so the cursor has to break the tie.
    const times = [1_000, 2_000, 2_000, 3_000, 4_000];
    for (const [i, rkey] of rkeys.entries()) await save(user, rkey, `Save ${i}`, times[i]);
    await env.DB.prepare(
      `INSERT INTO shelf_collections (id, user_did, name, position, created_at, updated_at) VALUES ('col1', ?, 'All', 0, 1, 1)`
    )
      .bind(user.did)
      .run();
    for (const [i, rkey] of rkeys.entries()) {
      // Same position for all: added_at, then rkey, order them.
      await env.DB.prepare(
        `INSERT INTO shelf_collection_items (user_did, collection_id, saved_rkey, position, added_at) VALUES (?, 'col1', ?, 0, ?)`
      )
        .bind(user.did, rkey, i < 2 ? 1 : i)
        .run();
    }
    const { accessToken } = await connect(user);

    async function walk(args: Record<string, unknown>) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let total: number | undefined;
      for (let i = 0; i < 10; i++) {
        const page = (await tool(accessToken, 'list_saved', { ...args, limit: 2, cursor }))
          .structuredContent;
        seen.push(...page.saved.map((s: { rkey: string }) => s.rkey));
        // Counted on every page.
        if (total !== undefined) expect(page.total).toBe(total);
        total = page.total;
        if (!page.hasMore) return { seen, total };
        cursor = page.nextCursor;
      }
      throw new Error('never ended');
    }

    const all = await walk({});
    expect(all.total).toBe(5);
    expect(new Set(all.seen).size).toBe(5);
    expect(all.seen[0]).toBe(rkeys[4]);
    expect(all.seen[4]).toBe(rkeys[0]);

    const shelf = await walk({ collectionId: 'col1' });
    expect(shelf.seen).toEqual(rkeys);

    const ranged = await walk({
      savedSince: new Date(2_000).toISOString(),
      savedBefore: new Date(4_000).toISOString(),
    });
    expect(ranged.total).toBe(3);
    expect(new Set(ranged.seen)).toEqual(new Set([rkeys[1], rkeys[2], rkeys[3]]));

    // A cursor from one list isn't taken by another.
    const first = await tool(accessToken, 'list_saved', { limit: 2 });
    const crossed = await tool(accessToken, 'list_saved', {
      collectionId: 'col1',
      cursor: first.structuredContent.nextCursor,
    });
    expect(crossed.isError).toBe(true);
    expect((await tool(accessToken, 'list_saved', { cursor: 'junk' })).isError).toBe(true);
    // Nor by the same list with other arguments: another filter, another collection.
    const ranged1 = await tool(accessToken, 'list_saved', {
      limit: 1,
      savedSince: new Date(2_000).toISOString(),
    });
    const refiltered = await tool(accessToken, 'list_saved', {
      limit: 1,
      savedSince: new Date(3_000).toISOString(),
      cursor: ranged1.structuredContent.nextCursor,
    });
    expect(refiltered.isError).toBe(true);
    const shelf1 = await tool(accessToken, 'list_saved', { collectionId: 'col1', limit: 1 });
    const otherShelf = await tool(accessToken, 'list_saved', {
      collectionId: 'col2',
      cursor: shelf1.structuredContent.nextCursor,
    });
    expect(otherShelf.isError).toBe(true);
    // A different limit is fine: it's the page size, not the list.
    const wider = await tool(accessToken, 'list_saved', {
      collectionId: 'col1',
      limit: 3,
      cursor: shelf1.structuredContent.nextCursor,
    });
    expect(wider.isError).toBeUndefined();
    expect(wider.structuredContent.saved).toHaveLength(3);
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
    expect(result.structuredContent.hasMore).toBe(false);

    const one = await tool(accessToken, 'list_highlights', { rkey: 'fffffffffffff' });
    expect(one.structuredContent.pages).toHaveLength(1);
    const byUrl = await tool(accessToken, 'list_highlights', {
      url: 'https://BLOG.example/fffffffffffff/?utm_source=x',
    });
    expect(byUrl.structuredContent.pages).toHaveLength(1);
    // A save with no highlights has none; a save that doesn't exist is an error.
    await save(user, 'hhhhhhhhhhhhh', 'Unmarked', 2_000);
    const none = await tool(accessToken, 'list_highlights', { rkey: 'hhhhhhhhhhhhh' });
    expect(none.structuredContent.pages).toEqual([]);
    const missing = await tool(accessToken, 'list_highlights', { rkey: 'ggggggggggggg' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('ggggggggggggg');
  });

  it('links highlights filed under another key to the save on the same page', async () => {
    const user = await createUser();
    await save(user, 'kkkkkkkkkkkkk', 'Same page', 1_000);
    const highlightRow = async (key: string, rkey: string, highlight: Record<string, unknown>) =>
      env.DB.prepare(
        `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
         VALUES (?, ?, 'article', 'highlights', ?, ?, 100, 200, 100000)`
      )
        .bind(user.did, key, JSON.stringify({ highlights: [highlight] }), rkey)
        .run();
    // Imported under the page's URL, written differently.
    await highlightRow('https://BLOG.example/kkkkkkkkkkkkk/?utm_source=feed', 'hl3', {
      id: 'h1',
      selector: { type: 'TextQuoteSelector', exact: 'filed by url' },
      createdAt: 10,
    });
    // Keyed by the page's URL with a fragment: normalized, the same page.
    await highlightRow('https://blog.example/kkkkkkkkkkkkk#part-2', 'hl4', {
      id: 'h2',
      selector: { type: 'TextQuoteSelector', exact: 'filed by url again' },
      createdAt: 20,
    });
    // A link post's highlight carries the article it links to, but it's on the
    // post: the URL stamped on highlights never joins a save.
    await highlightRow('feed-guid-1', 'hl5', {
      id: 'h3',
      selector: { type: 'TextQuoteSelector', exact: 'commentary on the link' },
      createdAt: 30,
      sourceUrl: 'https://blog.example/kkkkkkkkkkkkk',
    });
    const { accessToken } = await connect(user);

    const expected = {
      rkey: 'kkkkkkkkkkkkk',
      title: 'Same page',
      highlights: [{ text: 'filed by url' }, { text: 'filed by url again' }],
    };
    for (const args of [
      {},
      { rkey: 'kkkkkkkkkkkkk' },
      // What changed since: the rows are found by key, the save by their URL.
      { since: new Date(150_000).toISOString() },
    ]) {
      const result = await tool(accessToken, 'list_highlights', args);
      const saved = result.structuredContent.pages.filter(
        (p: { rkey: string | null }) => p.rkey === 'kkkkkkkkkkkkk'
      );
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject(expected);
    }
    const all = await tool(accessToken, 'list_highlights');
    expect(all.structuredContent.pages).toHaveLength(2);
    expect(all.structuredContent.pages[1]).toMatchObject({
      rkey: null,
      highlights: [{ text: 'commentary on the link' }],
    });

    // The joined keys follow the save's own, so a note made for the page
    // before it was saved is found again.
    const doc = await collectExport(env, user.did);
    expect(doc.sources[0].keys).toEqual([
      'saved:kkkkkkkkkkkkk',
      `at://${user.did}/app.skyreader.feed.saved/kkkkkkkkkkkkk`,
      'https://BLOG.example/kkkkkkkkkkkkk/?utm_source=feed',
      'https://blog.example/kkkkkkkkkkkkk#part-2',
    ]);

    // Deleting a joined row's last highlight is a change to the save, which
    // comes back with what's left, not an empty page under that key.
    await env.DB.prepare(
      `UPDATE item_labels_cache SET deleted_at = 300, updated_at = 300, props = NULL
        WHERE user_did = ? AND item_key = 'https://blog.example/kkkkkkkkkkkkk#part-2'`
    )
      .bind(user.did)
      .run();
    const changed = await collectExport(env, user.did, { since: 250 });
    expect(changed.sources).toHaveLength(1);
    expect(changed.sources[0]).toMatchObject({
      kind: 'save',
      id: 'saved:kkkkkkkkkkkkk',
      highlights: [{ text: 'filed by url' }],
    });
  });

  it('links highlights filed under an earlier save or a Margin note by the URL on them', async () => {
    const user = await createUser();
    await save(user, 'mmmmmmmmmmmmm', 'Saved again', 1_000);
    const highlightRow = async (key: string, rkey: string, highlight: Record<string, unknown>) =>
      env.DB.prepare(
        `INSERT INTO item_labels_cache (user_did, item_key, item_type, label, props, rkey, created_at, updated_at, client_updated_at)
         VALUES (?, ?, 'article', 'highlights', ?, ?, 100, 200, 100000)`
      )
        .bind(user.did, key, JSON.stringify({ highlights: [highlight] }), rkey)
        .run();
    // Highlighted under an earlier save of the page, since deleted.
    await highlightRow(`at://${user.did}/app.skyreader.feed.saved/3mylkprzxwpx4`, 'hl6', {
      id: 'h1',
      selector: { type: 'TextQuoteSelector', exact: 'from the first save' },
      createdAt: 10,
      sourceUrl: 'https://blog.example/mmmmmmmmmmmmm/',
    });
    // Imported from a Margin note on the page.
    await highlightRow(`at://${user.did}/at.margin.note/3mxt64ren6s26`, 'hl7', {
      id: 'h2',
      selector: { type: 'TextQuoteSelector', exact: 'from margin' },
      createdAt: 20,
      sourceUrl: 'https://blog.example/mmmmmmmmmmmmm',
    });
    const { accessToken } = await connect(user);

    for (const args of [
      {},
      { rkey: 'mmmmmmmmmmmmm' },
      { since: new Date(150_000).toISOString() },
    ]) {
      const result = await tool(accessToken, 'list_highlights', args);
      expect(result.structuredContent.pages).toHaveLength(1);
      expect(result.structuredContent.pages[0]).toMatchObject({
        rkey: 'mmmmmmmmmmmmm',
        highlights: [{ text: 'from the first save' }, { text: 'from margin' }],
      });
    }
    // Joined by what's stamped on them, so not one of the save's keys.
    const doc = await collectExport(env, user.did);
    expect(doc.sources[0].keys).toEqual([
      'saved:mmmmmmmmmmmmm',
      `at://${user.did}/app.skyreader.feed.saved/mmmmmmmmmmmmm`,
    ]);

    // A change to the Margin row, even deleting it, is a change to the save.
    await env.DB.prepare(
      `UPDATE item_labels_cache SET deleted_at = 300, updated_at = 300
        WHERE user_did = ? AND item_key LIKE '%at.margin.note%'`
    )
      .bind(user.did)
      .run();
    const changed = await collectExport(env, user.did, { since: 250 });
    expect(changed.sources).toHaveLength(1);
    expect(changed.sources[0]).toMatchObject({
      id: 'saved:mmmmmmmmmmmmm',
      highlights: [{ text: 'from the first save' }],
    });
  });

  it('pages a backed Saved list by position, so a save arriving mid-walk repeats nothing', async () => {
    const user = await createUser();
    const collection = `at://${user.did}/network.cosmik.collection/c1`;
    await env.DB.prepare(
      `INSERT INTO user_settings (user_did, backing, last_backing_poll, last_successful_backing_poll)
       VALUES (?, ?, 1, 1)`
    )
      .bind(user.did, `semble:${collection}`)
      .run();
    const member = async (key: string, title: string | null) =>
      env.DB.prepare(
        `INSERT INTO backed_collection_members
           (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
         VALUES (?, ?, ?, ?, 'semble', ?, ?, ?)`
      )
        .bind(
          user.did,
          collection,
          `https://blog.example/${key}`,
          `https://blog.example/${key}`,
          `at://other/network.cosmik.card/${key}`,
          `at://other/network.cosmik.card/${key}-link`,
          title ? JSON.stringify({ title }) : null
        )
        .run();
    const backedSave = async (rkey: string, savedAt: number) => {
      await env.DB.prepare(
        `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_normalized, title, saved_at, source)
         VALUES (?, ?, NULL, ?, ?, ?, ?, 'url')`
      )
        .bind(
          user.did,
          rkey,
          `https://blog.example/${rkey}`,
          `https://blog.example/${rkey}`,
          rkey,
          savedAt
        )
        .run();
      await member(rkey, null);
    };
    await backedSave('aaaaaaaaaaaaa', 1_000);
    await backedSave('bbbbbbbbbbbbb', 2_000);
    await backedSave('ccccccccccccc', 3_000);
    await member('only-in-semble', 'Added in Semble');
    const { accessToken } = await connect(user);

    const seen: (string | null)[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = (await tool(accessToken, 'list_saved', { limit: 1, cursor })).structuredContent;
      seen.push(
        ...page.saved.map((s: { rkey: string | null; title: string }) => s.rkey ?? s.title)
      );
      if (i === 0) await backedSave('ddddddddddddd', 9_000);
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    // Newest first; the new save landed above the walk, so it isn't in it; the
    // member with no save time comes last, once.
    expect(seen).toEqual(['ccccccccccccc', 'bbbbbbbbbbbbb', 'aaaaaaaaaaaaa', 'Added in Semble']);
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
    // A misspelled or retired argument is refused, not ignored.
    for (const args of [{ since: '2026-01-01' }, { offset: 50 }]) {
      const refused = await tool(accessToken, 'list_saved', args);
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain(Object.keys(args)[0]);
      expect(refused.content[0].text).toContain('savedSince');
    }
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
