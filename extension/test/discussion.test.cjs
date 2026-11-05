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

const discussionUrl = (send, url) => send({ type: 'discussionUrl', url }).then((r) => r.url);

test('names the production link page, keeping the query and dropping the fragment', async () => {
  const { send } = worker();
  assert.equal(
    await discussionUrl(send, 'https://example.com/post?id=7#top'),
    'https://read.skyreader.app/https://example.com/post?id=7'
  );
});

test('maps each web app to its read host', async () => {
  const cases = [
    ['https://staging.skyreader.app', 'https://staging-read.skyreader.app/https://example.com/a'],
    ['https://staging-prod.skyreader.app', 'https://read.skyreader.app/https://example.com/a'],
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5175/link/https://example.com/a'],
  ];
  for (const [frontendBase, expected] of cases) {
    const { send } = worker({ frontendBase });
    assert.equal(await discussionUrl(send, 'https://example.com/a'), expected);
  }
});

test('has no link page for a page that is not on the public web', async () => {
  const { send, opened } = worker();
  for (const url of [
    'chrome://extensions',
    'about:blank',
    'http://localhost:3000/x',
    `https://example.com/${'a'.repeat(2048)}`,
  ]) {
    assert.equal(await discussionUrl(send, url), null);
  }
  assert.deepEqual(opened, []);
});
