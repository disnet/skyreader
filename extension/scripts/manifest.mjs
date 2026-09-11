// Per-target manifest transforms.
//
// One source manifest (manifest.json) serves unpacked development in both
// browsers: it carries both background keys and the Firefox add-on id, so the
// repo directory loads as-is in chrome://extensions and about:debugging. Each
// store build then gets only what its browser accepts, because neither store
// tolerates the other's keys.

export const TARGETS = ['chrome', 'firefox'];

export function manifestFor(target, source) {
  if (!TARGETS.includes(target)) {
    throw new Error(`unknown target "${target}" (expected one of: ${TARGETS.join(', ')})`);
  }

  const manifest = structuredClone(source);

  // Server overrides are only for unpacked development. Store builds use
  // production URLs without settings or storage, including previously synced
  // overrides.
  delete manifest.optional_host_permissions;
  delete manifest.options_ui;
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'storage');

  if (target === 'chrome') {
    // Chrome has no MV3 event pages: it only tolerates `background.scripts`
    // alongside the service worker as an ignored key, with a load warning.
    delete manifest.background.scripts;
    // Gecko-only key; Chrome reports it as unrecognized.
    delete manifest.browser_specific_settings;
  } else {
    // Firefox has no extension service workers, and AMO review rejects a
    // manifest that declares one even though the browser would ignore it.
    delete manifest.background.service_worker;
  }

  return manifest;
}
