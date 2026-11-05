const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../background.js'), 'utf8');

// "See the conversation" opens the page's public link page. It makes no API
// call, so it needs neither a session nor host access.
function worker(config = {}) {
  let listener;
  const opened = [];
  const stub = {
    storage: { sync: { get: async (defaults) => ({ ...defaults, ...config }) } },
    runtime: {
      getManifest: () => ({ permissions: ['storage'] }),
      onMessage: { addListener: (fn) => (listener = fn) },
      onInstalled: { addListener() {} },
    },
    permissions: { contains: async () => false },
    contextMenus: { onClicked: { addListener() {} } },
    tabs: { create: async ({ url }) => opened.push(url) },
    action: {},
    scripting: {},
  };
  const fetch = async () => {
    throw new Error('no network expected');
  };
  vm.runInContext(source, vm.createContext({ fetch, URL, setTimeout, chrome: stub }));
  const send = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
  return { send, opened };
}

test('opens the production link page for the page, keeping its query and dropping its fragment', async () => {
  const { send, opened } = worker();
  const res = await send({ type: 'discussion', url: 'https://example.com/post?id=7#top' });
  assert.equal(res.ok, true);
  assert.deepEqual(opened, ['https://read.skyreader.app/https://example.com/post?id=7']);
});

test('a local web app maps to the linkblog dev server', async () => {
  const { send, opened } = worker({ frontendBase: 'http://127.0.0.1:5173' });
  await send({ type: 'discussion', url: 'https://example.com/a' });
  assert.deepEqual(opened, ['http://127.0.0.1:5175/link/https://example.com/a']);
});

test('opens nothing for a page that is not on the public web', async () => {
  const { send, opened } = worker();
  for (const url of ['chrome://extensions', 'about:blank', 'http://localhost:3000/x']) {
    const res = await send({ type: 'discussion', url });
    assert.equal(res.ok, false);
  }
  assert.deepEqual(opened, []);
});
