const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../background.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(__dirname, '../manifest.json'), 'utf8'));

function worker(fetch, config = {}, permissions = manifest.permissions) {
  let listener;
  const context = vm.createContext({
    fetch,
    URL,
    setTimeout,
    chrome: {
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
      contextMenus: { onClicked: { addListener() {} } },
    },
  });
  vm.runInContext(source, context);
  return (type) => new Promise((resolve) => listener({ type }, {}, resolve));
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
