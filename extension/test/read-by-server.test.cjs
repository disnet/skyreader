const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../background.js'), 'utf8');

// A Bluesky post is read by the server (its author's whole thread, from the
// appview), not from the tab, which holds only what it has rendered.
function readByServer() {
  const listen = { addListener() {} };
  const stub = {
    storage: { sync: { get: async (d) => d } },
    runtime: { getManifest: () => ({ permissions: [] }), onMessage: listen, onInstalled: listen },
    permissions: { contains: async () => false },
    contextMenus: { onClicked: listen },
    tabs: {},
    action: {},
    scripting: {},
  };
  const context = vm.createContext({ fetch: async () => {}, URL, setTimeout, chrome: stub });
  vm.runInContext(source, context);
  return vm.runInContext('readByServer', context);
}

test('sends a Bluesky post to the server extractor', () => {
  const fn = readByServer();
  assert.equal(fn('https://bsky.app/profile/me.example/post/3mabc'), true);
  assert.equal(fn('https://bsky.app/profile/did:plc:xyz/post/3mabc/'), true);
});

test('reads every other page from the tab', () => {
  const fn = readByServer();
  assert.equal(fn('https://bsky.app/profile/me.example'), false);
  assert.equal(fn('https://bsky.app/'), false);
  assert.equal(fn('https://example.com/profile/a/post/3mabc'), false);
  assert.equal(fn('not a url'), false);
});
