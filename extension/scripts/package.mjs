// Stage one browser build (and ZIP the Chrome/Firefox store builds):
// `node scripts/package.mjs [chrome|firefox|safari]`.
//
// Every target ships the same code; the manifest differs (see
// scripts/manifest.mjs) and so does the content-script build. The staging tree
// is left behind at dist/<target>/ so it can be loaded unpacked, linted
// (`npx web-ext lint --source-dir dist/firefox`), or handed to Xcode
// (dist/safari is what the Safari wrapper app builds from) without unzipping.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { manifestFor, TARGETS } from './manifest.mjs';

const target = process.argv[2] || 'chrome';
// `--dev` (Safari only): point the build at the local dev servers. Safari has
// no unpacked load and store builds strip the options page, so the local URLs
// are baked in instead. Xcode builds this with SKYREADER_DEV=1.
const dev = process.argv.includes('--dev');
const DEV_URLS = {
  "apiBase: 'https://api.skyreader.app'": "apiBase: 'http://127.0.0.1:8787'",
  "frontendBase: 'https://skyreader.app'": "frontendBase: 'http://127.0.0.1:5173'",
};
if (dev && target !== 'safari') {
  console.error('--dev is only for the Safari build (the others load unpacked)');
  process.exit(1);
}
if (!TARGETS.includes(target)) {
  console.error(`usage: node scripts/package.mjs [${TARGETS.join('|')}]`);
  process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = join(root, 'dist', target);
const archive = join(root, `skyreader-extension-${target}.zip`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// Node's recursive cpSync is unreliable on some mounted CI workspaces. Keep
// the runtime copy deterministic and use only the well-supported file form.
function copyRuntime(source, destination) {
  if (!statSync(source).isDirectory()) {
    cpSync(source, destination);
    return;
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    copyRuntime(join(source, entry), join(destination, entry));
  }
}

// Explicit runtime files only: development tools never enter the store ZIP.
for (const file of ['background.js', 'popup.html', 'popup.js', 'icons', 'LICENSE']) {
  copyRuntime(join(root, file), join(staging, file));
}
if (dev) {
  for (const file of ['background.js', 'popup.js']) {
    const path = join(staging, file);
    let code = readFileSync(path, 'utf8');
    for (const [from, to] of Object.entries(DEV_URLS)) {
      if (!code.includes(from)) throw new Error(`${file}: expected ${from}`);
      code = code.replace(from, to);
    }
    writeFileSync(path, code);
  }
}
// Safari's own-login landing page (see manifest.mjs).
if (target === 'safari') {
  for (const file of ['connected.html', 'connected.js']) {
    copyRuntime(join(root, file), join(staging, file));
  }
}

// The Defuddle content script is bundled straight into the staging tree rather
// than copied from the checked-in `npm run build` output, because the targets
// want different bundles: AMO requires a source-code submission for minified
// code, so the Firefox build stays readable. It's a content script, so the size
// difference doesn't matter. Chrome and Safari (App Review has no such
// requirement) ship the minified bundle.
execFileSync(
  join(root, 'node_modules/.bin/esbuild'),
  [
    join(root, 'src/extract-entry.js'),
    '--bundle',
    '--format=iife',
    // esbuild walks up from the entry point looking for a tsconfig, and would
    // find the monorepo root's (whose `strict: true` adds a "use strict"
    // prologue). An AMO reviewer builds from the source package, which has no
    // parent, so the bundle has to depend on nothing above this directory or
    // their rebuild won't match the upload.
    '--tsconfig-raw={}',
    ...(target === 'firefox' ? [] : ['--minify']),
    `--outfile=${join(staging, 'content/extract.js')}`,
  ],
  { stdio: 'inherit' }
);

const source = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const manifest = manifestFor(target, source);
if (dev) manifest.host_permissions = ['http://127.0.0.1/*'];
writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Safari's containing Xcode app is the distributable; the staged directory is
// copied into its extension bundle and there is no ZIP to upload.
if (target !== 'safari') {
  rmSync(archive, { force: true });
  execFileSync('zip', ['-r', archive, '.', '-x', '*.DS_Store'], {
    cwd: staging,
    stdio: 'inherit',
  });
}
