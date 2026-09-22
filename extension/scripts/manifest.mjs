// Per-target manifest transforms.
//
// One source manifest (manifest.json) serves unpacked development in every
// browser: it carries both background keys and the Firefox add-on id, so the
// repo directory loads as-is in chrome://extensions, about:debugging, and the
// converter-generated Xcode project. Each store build then gets only what its
// browser accepts, because no store tolerates another's keys.

export const TARGETS = ['chrome', 'firefox', 'safari'];

// Safari 16.4 is the first release with full MV3 (`scripting`, service-worker
// backgrounds, `permissions.request`). Keep this in step with whatever the
// Xcode project's deployment target allows.
export const SAFARI_MIN_VERSION = '16.4';

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
  } else if (target === 'safari') {
    // Safari supports either background key, but the converter warns about the
    // one it ignores, so ship exactly one. The event page is the lifecycle this
    // code has already been running under in Firefox.
    delete manifest.background.service_worker;
    manifest.background.persistent = false;
    // The Gecko block is AMO-only (`data_collection_permissions` means nothing
    // to Safari); the version floor is the one key Safari reads here.
    manifest.browser_specific_settings = { safari: { strict_min_version: SAFARI_MIN_VERSION } };
    // Safari won't send the session cookie on extension fetches, so the
    // extension logs in on its own: the backend redirects to connected.html
    // with a session id, kept in storage.local and sent as a Bearer token.
    // The page must be web-accessible for that redirect to land.
    manifest.permissions.push('storage');
    manifest.web_accessible_resources = [
      { resources: ['connected.html'], matches: ['<all_urls>'] },
    ];
  } else {
    // Firefox has no extension service workers, and AMO review rejects a
    // manifest that declares one even though the browser would ignore it.
    delete manifest.background.service_worker;
  }

  return manifest;
}
