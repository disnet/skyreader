import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure-disk assertions on the built service worker — no browser needed. These are the
// cheap regression guards: a green `vite build` is NOT enough (the precache-install 404
// that bricked the worker passed the build). Run once, on chromium only.
const buildDir = resolve(dirname(fileURLToPath(import.meta.url)), '../frontend/build');
const swPath = resolve(buildDir, 'service-worker.js');

test.describe('built service worker', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'disk-only checks run once');

  let sw = '';
  let manifestUrls: string[] = [];

  test.beforeAll(() => {
    expect(existsSync(swPath), `expected a production build at ${swPath}`).toBe(true);
    sw = readFileSync(swPath, 'utf8');
    // Match the injected Workbox precache entries precisely: {"revision":...,"url":"..."}.
    manifestUrls = [
      ...sw.matchAll(/\{"revision":(?:null|"(?:[^"\\]|\\.)*"),"url":"((?:[^"\\]|\\.)*)"\}/g),
    ].map((m) => m[1].replace(/\\\//g, '/'));
  });

  test('precaches the SPA shell as "/" — not "index.html"', () => {
    // The install-time precache FETCHES this URL. Hosts serve the shell at "/" but may
    // 404 on "/index.html"; a 404 rejects install and the worker never activates.
    expect(manifestUrls.length).toBeGreaterThan(50);
    expect(manifestUrls).toContain('/');
    expect(manifestUrls).not.toContain('index.html');
  });

  test('every precache URL maps to a real file in build/', () => {
    for (const url of manifestUrls) {
      const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
      expect(existsSync(resolve(buildDir, rel)), `no build asset for precache URL "${url}"`).toBe(
        true
      );
    }
  });

  test('registers the worker with an ABSOLUTE url + root scope', () => {
    // The registration is emitted into the app bundle (workbox-window's `new Workbox(url,
    // {scope})`), not into service-worker.js. SvelteKit 2's paths.relative=true makes Vite's
    // base "./", which would emit "./service-worker.js" + scope "./". That resolves relative
    // to whatever route first installs the SW (e.g. "/auth/callback" → "/auth/service-worker.js",
    // scope "/auth/"), 404s to the SPA fallback, and bricks install. We pin scope/buildBase to
    // "/" in vite.config.ts; assert the built bundle never reintroduces a relative form.
    const immutable = resolve(buildDir, '_app/immutable');
    const jsFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) jsFiles.push(full);
      }
    };
    walk(immutable);

    const swRefs = jsFiles
      .map((f) => readFileSync(f, 'utf8'))
      .filter((src) => src.includes('service-worker.js'));
    expect(swRefs.length, 'no bundle chunk references service-worker.js').toBeGreaterThan(0);

    for (const src of swRefs) {
      // Workbox is registered as `new <minified>("<url>",{scope:"<scope>",...})`.
      // Rolldown may emit string literals with quotes or backticks, so do not couple
      // this safety assertion to a particular minifier delimiter.
      const reg = src.match(
        /\(\s*(["'`])((?:\.\/)?\/?service-worker\.js)\1\s*,\s*\{\s*scope\s*:\s*(["'`])([^"'`]*)\3/
      );
      expect(reg, 'could not locate the Workbox registration call').not.toBeNull();
      expect(reg![2], 'SW url must be root-absolute, not relative').toBe('/service-worker.js');
      expect(reg![4], 'SW scope must be "/", not relative').toBe('/');
    }
  });

  test('keeps the skip-waiting + sync + periodic-sync handler contracts', () => {
    for (const token of [
      'SKIP_WAITING', // update flow: useRegisterSW(...).updateServiceWorker posts this
      'periodicsync',
      'sync-queue',
      'PROCESS_SYNC_QUEUE', // consumed in sync.svelte.ts
      'BACKGROUND_REFRESH_REQUESTED', // consumed in sync.svelte.ts
    ]) {
      expect(sw, `built service worker no longer contains "${token}"`).toContain(token);
    }
  });
});
