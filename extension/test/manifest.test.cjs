// The source manifest carries both browsers' keys so the repo directory loads
// unpacked in either one. These tests pin what each store build is allowed to
// contain, since neither store tolerates the other's background key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = JSON.parse(readFileSync(join(__dirname, '../manifest.json'), 'utf8'));
const load = () => import('../scripts/manifest.mjs');

test('the source manifest carries both background keys for unpacked development', () => {
  assert.equal(source.background.service_worker, 'background.js');
  assert.deepEqual(source.background.scripts, ['background.js']);
});

test('the Chrome build declares a service worker and no Gecko keys', async () => {
  const { manifestFor } = await load();
  const manifest = manifestFor('chrome', source);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.scripts, undefined);
  assert.equal(manifest.browser_specific_settings, undefined);
});

test('the Firefox build declares an event page and keeps the add-on id', async () => {
  const { manifestFor } = await load();
  const manifest = manifestFor('firefox', source);
  // AMO rejects a manifest declaring a service worker, even though Firefox
  // would ignore the key.
  assert.equal(manifest.background.service_worker, undefined);
  assert.deepEqual(manifest.background.scripts, ['background.js']);
  // Required by AMO, and storage.sync silently does nothing without it.
  assert.ok(manifest.browser_specific_settings.gecko.id);
  // Required for new AMO submissions since November 2025.
  assert.ok(manifest.browser_specific_settings.gecko.data_collection_permissions.required.length);
});

test('neither store build ships the development server override', async () => {
  const { manifestFor, TARGETS } = await load();
  for (const target of TARGETS) {
    const manifest = manifestFor(target, source);
    assert.equal(manifest.options_ui, undefined, target);
    assert.equal(manifest.optional_host_permissions, undefined, target);
    assert.ok(!manifest.permissions.includes('storage'), target);
  }
});

test('transforming does not mutate the source manifest', async () => {
  const { manifestFor, TARGETS } = await load();
  const before = JSON.stringify(source);
  for (const target of TARGETS) manifestFor(target, source);
  assert.equal(JSON.stringify(source), before);
});
