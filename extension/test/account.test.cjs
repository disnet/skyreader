const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../background.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(__dirname, '../manifest.json'), 'utf8'));

// `namespace` picks which global the background script should bind to: Chrome
// only defines `chrome`, Firefox defines both (and only `browser` is
// promise-based), so the script prefers `browser` and falls back.
function worker(
  fetch,
  config = {},
  permissions = manifest.permissions,
  {
    hostAccess = true,
    namespace = 'chrome',
    contextMenus = true,
    badgeTextColor = true,
    timer = setTimeout,
    // Extra manifest keys, e.g. the Safari build's web_accessible_resources.
    manifestExtra = {},
    local = {},
    tabs = [],
  } = {}
) {
  const isDev = permissions.includes('storage') && !manifestExtra.web_accessible_resources;
  let listener;
  let installed;
  let menuClick;
  const menus = [];
  const stub = {
    storage: {
      sync: {
        get: async (defaults) => {
          assert.ok(isDev, 'store builds must not read development settings');
          return { ...defaults, ...config };
        },
      },
      local: {
        get: async (key) => (key in local ? { [key]: local[key] } : {}),
        set: async (values) => Object.assign(local, values),
        remove: async (key) => delete local[key],
      },
    },
    runtime: {
      // The source manifest's `storage` + options page mark unpacked development.
      getManifest: () => ({
        permissions,
        ...(isDev ? { options_ui: manifest.options_ui } : {}),
        ...manifestExtra,
      }),
      getURL: (path) => `safari-web-extension://test-id/${path}`,
      onMessage: { addListener: (fn) => (listener = fn) },
      onInstalled: { addListener: (fn) => (installed = fn) },
    },
    permissions: { contains: async () => hostAccess },
    // Safari on iOS/iPadOS has no contextMenus API at all.
    contextMenus: contextMenus
      ? {
          create: (menu) => menus.push(menu),
          onClicked: { addListener: (fn) => (menuClick = fn) },
        }
      : undefined,
    tabs: { create: async (tab) => tabs.push(tab) },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      // Not implemented in Safari.
      ...(badgeTextColor ? { setBadgeTextColor: async () => {} } : {}),
      setTitle: async () => {},
    },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  const context = vm.createContext({ fetch, URL, crypto, setTimeout: timer, [namespace]: stub });
  vm.runInContext(source, context);
  const send = (msg) =>
    new Promise((resolve) => listener(typeof msg === 'string' ? { type: msg } : msg, {}, resolve));
  // The install-time and context-menu hooks hang off `send` so the tests that
  // exercise those entry points don't need a second harness.
  send.install = () => installed();
  send.clickMenu = (info, tab) => menuClick(info, tab);
  send.menus = menus;
  return send;
}

test('account uses the configured server and shared cookie, returning only identity', async () => {
  const send = worker(
    async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8787/api/auth/me');
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'include');
      return Response.json({ did: 'did:plc:alice', handle: 'alice.test', tier: 'free' });
    },
    { apiBase: 'http://127.0.0.1:8787' }
  );
  const result = await send('account');
  assert.equal(result.ok, true);
  assert.equal(result.user.handle, 'alice.test');
  assert.equal(result.user.did, 'did:plc:alice');
  assert.equal(result.user.tier, undefined);
});

test('store account uses production and ignores previously synced development settings', async () => {
  const send = worker(
    async (url, options) => {
      assert.equal(url, 'https://api.skyreader.app/api/auth/me');
      assert.equal(options.credentials, 'include');
      return Response.json({ did: 'did:plc:alice', handle: 'alice.test' });
    },
    { apiBase: 'http://127.0.0.1:8787', frontendBase: 'http://127.0.0.1:5173' },
    manifest.permissions.filter((permission) => permission !== 'storage')
  );
  const result = await send('account');
  assert.equal(result.ok, true);
  assert.equal(result.user.handle, 'alice.test');
});

test('only a confirmed 401 is shown as logged out', async () => {
  for (const status of [401, 500, 503]) {
    const result = await worker(async () => new Response(null, { status }))('account');
    assert.equal(result.ok, status === 401);
    if (status === 401) assert.equal(result.user, null);
    else assert.equal(result.user, undefined);
  }
});

test('network failures are returned through the message router', async () => {
  const send = worker(async () => {
    throw new Error('Offline');
  });
  const result = await send('account');
  assert.equal(result.ok, false);
  assert.match(result.error, /Offline/);
});

test('the background binds to browser when it exists, and to chrome otherwise', async () => {
  for (const namespace of ['chrome', 'browser']) {
    const send = worker(
      async () => Response.json({ did: 'did:plc:alice', handle: 'alice.test' }),
      {},
      manifest.permissions,
      { namespace }
    );
    const result = await send('account');
    assert.equal(result.ok, true, `background should work on the ${namespace} namespace`);
    assert.equal(result.user.handle, 'alice.test');
  }
});

test('without host access a save never reaches the network', async () => {
  const send = worker(
    async () => assert.fail('no request should be made without host access'),
    {},
    manifest.permissions,
    { hostAccess: false }
  );
  const result = await send({ type: 'save', url: 'https://example.com/post' });
  // The popup renders a grant prompt from this; the context menu hands off to
  // the web app's /save page, which does not need the extension's host access.
  assert.equal(result.status, 'permission');
  assert.equal(result.url, 'https://example.com/post');
});

test('without host access a subscribe never reaches the network', async () => {
  const send = worker(
    async () => assert.fail('no request should be made without host access'),
    {},
    manifest.permissions,
    { hostAccess: false }
  );
  const result = await send({
    type: 'subscribe',
    feed: { kind: 'rss', feedUrl: 'https://example.com/feed.xml' },
  });
  assert.equal(result.status, 'permission');
});

// Safari is the browser these guards exist for: iOS/iPadOS has no contextMenus
// API, and no Safari implements action.setBadgeTextColor. A missing API must
// cost the affordance, not throw out of a top-level listener and take the whole
// background script down with it.
test('context menus register where the browser has them', async () => {
  const send = worker(async () => Response.json({}));
  send.install();
  assert.deepEqual(
    send.menus.map((menu) => menu.id),
    ['save-link', 'save-page']
  );
});

test('a browser without context menus still loads and installs', async () => {
  const send = worker(
    async () => Response.json({ did: 'did:plc:alice', handle: 'alice.test' }),
    {},
    manifest.permissions,
    {
      contextMenus: false,
    }
  );
  send.install();
  const result = await send('account');
  assert.equal(result.ok, true);
});

test('a save from the context menu survives a missing setBadgeTextColor', async () => {
  const seen = [];
  let saved;
  const done = new Promise((resolve) => (saved = resolve));
  const send = worker(
    async (url) => {
      seen.push(new URL(url).pathname);
      if (url.endsWith('/api/saved')) {
        saved();
        return Response.json({ saved: true }, { status: 201 });
      }
      return Response.json({ title: 'Post', content: '<p>body</p>' });
    },
    {},
    manifest.permissions,
    // Badge clearing is a 4s timer; dropping it keeps the run from waiting.
    { badgeTextColor: false, timer: () => 0 }
  );
  send.clickMenu({ menuItemId: 'save-page', pageUrl: 'https://example.com/post' }, { id: 7 });
  await done;
  assert.deepEqual(seen, ['/api/extract', '/api/saved']);
});

// Safari won't send the website's session cookie with an extension's fetches,
// so the Safari build logs in on its own and sends a stored Bearer session.
const SAFARI = {
  manifestExtra: {
    web_accessible_resources: [{ resources: ['connected.html'], matches: ['<all_urls>'] }],
  },
};
const safariPermissions = [...manifest.permissions];

test('Safari sends its stored session as a Bearer token', async () => {
  const send = worker(
    async (url, options) => {
      assert.equal(url, 'https://api.skyreader.app/api/auth/me');
      assert.equal(options.headers.Authorization, 'Bearer sess-123');
      return Response.json({ did: 'did:plc:alice', handle: 'alice.test' });
    },
    {},
    safariPermissions,
    { ...SAFARI, local: { session: 'sess-123' } }
  );
  const result = await send('account');
  assert.equal(result.user.handle, 'alice.test');
});

test('Safari drops a session the server no longer accepts', async () => {
  const local = { session: 'expired' };
  const send = worker(async () => new Response(null, { status: 401 }), {}, safariPermissions, {
    ...SAFARI,
    local,
  });
  const result = await send('account');
  assert.equal(result.user, null);
  assert.equal(local.session, undefined);
});

test('Safari login opens the web login with a nonce-bound return page', async () => {
  const local = {};
  const tabs = [];
  const send = worker(async () => assert.fail('login makes no API call'), {}, safariPermissions, {
    ...SAFARI,
    local,
    tabs,
  });
  const result = await send('login');
  assert.equal(result.handled, true);
  const opened = new URL(tabs[0].url);
  assert.equal(opened.origin + opened.pathname, 'https://skyreader.app/auth/login');
  const back = new URL(opened.searchParams.get('extensionReturn'));
  assert.equal(back.pathname, '/connected.html');
  assert.equal(back.searchParams.get('nonce'), local.pendingLogin.nonce);
  assert.ok(local.pendingLogin.nonce.length >= 32);
});

test('other browsers leave login to the website and send no Authorization', async () => {
  const tabs = [];
  const send = worker(
    async (_url, options) => {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(null, { status: 401 });
    },
    {},
    manifest.permissions.filter((permission) => permission !== 'storage'),
    { tabs }
  );
  assert.equal((await send('login')).handled, false);
  assert.equal(tabs.length, 0);
  assert.equal((await send('account')).user, null);
});

test('Safari logout ends the session on the server and forgets it locally', async () => {
  const local = { session: 'sess-123' };
  const calls = [];
  const send = worker(
    async (url, options) => {
      calls.push([url, options.method, options.headers.Authorization]);
      return Response.json({ ok: true });
    },
    {},
    safariPermissions,
    { ...SAFARI, local }
  );
  await send('logout');
  assert.deepEqual(calls, [
    ['https://api.skyreader.app/api/auth/logout', 'POST', 'Bearer sess-123'],
  ]);
  assert.equal(local.session, undefined);
});

test('Safari logout still forgets the session when the server is unreachable', async () => {
  const local = { session: 'sess-123' };
  const send = worker(
    async () => {
      throw new Error('Offline');
    },
    {},
    safariPermissions,
    { ...SAFARI, local }
  );
  assert.equal((await send('logout')).ok, true);
  assert.equal(local.session, undefined);
});

test('only an extension-held session is offered a logout', async () => {
  const me = async () => Response.json({ did: 'did:plc:alice', handle: 'alice.test' });
  const safari = await worker(me, {}, safariPermissions, {
    ...SAFARI,
    local: { session: 's' },
  })('account');
  assert.equal(safari.ownSession, true);
  const chrome = await worker(me)('account');
  assert.equal(chrome.ownSession, false);
});
