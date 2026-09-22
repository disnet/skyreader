// The source manifest carries every browser's keys so the repo directory loads
// unpacked in any of them. These tests pin what each store build is allowed to
// contain, since no store tolerates another's background key.
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

test('the Safari build declares one background key and a Safari version floor', async () => {
  const { manifestFor, SAFARI_MIN_VERSION } = await load();
  const manifest = manifestFor('safari', source);
  // Safari reads either key but the converter warns on the one it ignores, so
  // exactly one ships — the event page, the lifecycle Firefox already exercises.
  assert.equal(manifest.background.service_worker, undefined);
  assert.deepEqual(manifest.background.scripts, ['background.js']);
  assert.equal(manifest.background.persistent, false);
  // The Gecko block is AMO-only and means nothing to Safari.
  assert.equal(manifest.browser_specific_settings.gecko, undefined);
  assert.equal(manifest.browser_specific_settings.safari.strict_min_version, SAFARI_MIN_VERSION);
});

test('only the Safari build carries its own login', async () => {
  const { manifestFor } = await load();
  // Safari won't share the website's session cookie with the extension, so it
  // stores its own session (storage) from a web-accessible landing page.
  const safari = manifestFor('safari', source);
  assert.ok(safari.permissions.includes('storage'));
  assert.deepEqual(safari.web_accessible_resources[0].resources, ['connected.html']);
  for (const target of ['chrome', 'firefox']) {
    const manifest = manifestFor(target, source);
    assert.ok(!manifest.permissions.includes('storage'), target);
    assert.equal(manifest.web_accessible_resources, undefined, target);
  }
});

test('no store build ships the development server override', async () => {
  const { manifestFor, TARGETS } = await load();
  for (const target of TARGETS) {
    const manifest = manifestFor(target, source);
    assert.equal(manifest.options_ui, undefined, target);
    assert.equal(manifest.optional_host_permissions, undefined, target);
  }
});

test('transforming does not mutate the source manifest', async () => {
  const { manifestFor, TARGETS } = await load();
  const before = JSON.stringify(source);
  for (const target of TARGETS) manifestFor(target, source);
  assert.equal(JSON.stringify(source), before);
});
