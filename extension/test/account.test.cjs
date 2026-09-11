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
  { hostAccess = true, namespace = 'chrome' } = {}
) {
  let listener;
  const stub = {
    storage: {
      sync: {
        get: async (defaults) => {
          assert.ok(permissions.includes('storage'), 'store builds must not access storage');
          return { ...defaults, ...config };
        },
      },
    },
    runtime: {
      getManifest: () => ({ permissions }),
      onMessage: { addListener: (fn) => (listener = fn) },
      onInstalled: { addListener() {} },
    },
    permissions: { contains: async () => hostAccess },
    contextMenus: { onClicked: { addListener() {} } },
    tabs: { create() {} },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      setTitle: async () => {},
    },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  const context = vm.createContext({ fetch, URL, setTimeout, [namespace]: stub });
  vm.runInContext(source, context);
  return (msg) =>
    new Promise((resolve) => listener(typeof msg === 'string' ? { type: msg } : msg, {}, resolve));
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
