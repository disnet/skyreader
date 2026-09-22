const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../connected.js'), 'utf8');

// Runs connected.js as if the backend redirected to
// connected.html?<search>#<hash>, and resolves with the heading it showed.
function land({ search = '', hash = '', local }) {
  return new Promise((resolve) => {
    const nodes = {
      title: {
        set textContent(text) {
          resolve(text);
        },
      },
      detail: { textContent: '' },
      main: { className: '' },
    };
    const context = vm.createContext({
      URLSearchParams,
      Date,
      Object,
      location: { search, hash, pathname: '/connected.html' },
      history: { replaceState: () => {} },
      document: { getElementById: (id) => nodes[id] },
      chrome: {
        storage: {
          local: {
            get: async (key) => (key in local ? { [key]: structuredClone(local[key]) } : {}),
            set: async (values) => Object.assign(local, structuredClone(values)),
          },
        },
      },
    });
    vm.runInContext(source, context);
  });
}

test('a matching nonce stores the session and consumes only its own login', async () => {
  const now = Date.now();
  const local = { pendingLogins: { aaa: now, bbb: now } };
  const title = await land({ search: '?nonce=aaa', hash: '#session_id=sess-1', local });
  assert.match(title, /logged in/);
  assert.equal(local.session, 'sess-1');
  assert.deepEqual(Object.keys(local.pendingLogins), ['bbb']);
});

test('a stray visit leaves an in-progress login alone', async () => {
  const local = { pendingLogins: { aaa: Date.now() } };
  const title = await land({ search: '?nonce=zzz', hash: '#session_id=planted', local });
  assert.match(title, /Couldn’t connect/);
  assert.equal(local.session, undefined);
  assert.deepEqual(Object.keys(local.pendingLogins), ['aaa']);
  // The real login still completes afterwards.
  await land({ search: '?nonce=aaa', hash: '#session_id=sess-1', local });
  assert.equal(local.session, 'sess-1');
});

test('an expired login is refused', async () => {
  const local = { pendingLogins: { aaa: Date.now() - 60 * 60 * 1000 } };
  const title = await land({ search: '?nonce=aaa', hash: '#session_id=sess-1', local });
  assert.match(title, /Couldn’t connect/);
  assert.equal(local.session, undefined);
});
