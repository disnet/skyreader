import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = mkdtempSync(join(tmpdir(), 'skyreader-extension-'));

try {
  // Explicit runtime files only: development tools never enter the store ZIP.
  for (const file of [
    'background.js',
    'popup.html',
    'popup.js',
    'content/extract.js',
    'icons',
    'LICENSE',
  ]) {
    cpSync(join(root, file), join(staging, file), { recursive: true });
  }

  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  // Server overrides are only for unpacked development. Store builds use
  // production URLs without settings or storage, including previously synced
  // overrides. Leave the source manifest intact for local development.
  delete manifest.optional_host_permissions;
  delete manifest.options_ui;
  manifest.permissions = manifest.permissions.filter((permission) => permission !== 'storage');
  writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const archive = 'skyreader-extension.zip';
  execFileSync('zip', ['-r', archive, '.', '-x', '*.DS_Store'], {
    cwd: staging,
    stdio: 'inherit',
  });
  renameSync(join(staging, archive), join(root, archive));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
