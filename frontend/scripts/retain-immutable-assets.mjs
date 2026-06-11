#!/usr/bin/env node
// Carry forward previous deploys' immutable build assets.
//
// Cloudflare Pages serves only the latest deployment, so the moment a deploy goes
// live, every hashed chunk from earlier builds 404s. A still-open old tab that
// lazy-imports one of those chunks breaks and has to be rescued by the
// vite:preloadError reload in hooks.client.ts. But /_app/immutable/* files are
// content-hashed and immutable — there is no correctness reason to ever stop
// serving them. So before deploying, this script downloads recently-served
// immutable assets from the live site and merges them into the new build, making
// retention part of the deployment itself (no extra storage infra).
//
// State lives in _app/retained-assets.json, deployed alongside the build:
//   { "version": 1, "assets": { "<path>": "<ISO date the asset last shipped in a build>" } }
// Each run stamps the current build's assets with now, carries forward previous
// entries until they go MAX_AGE_DAYS without appearing in a build, and downloads
// any carried asset missing locally. If the live site has no manifest yet
// (first run), the currently-live build is recovered from its service worker's
// precache manifest so adoption itself doesn't strand open tabs.
//
// Failures are deliberately soft: retention is an optimization layered over the
// preloadError reload backstop, so a fresh project or unreachable origin warns
// and deploys without retained assets rather than blocking the deploy.
//
// Usage: node scripts/retain-immutable-assets.mjs <build-dir> <live-origin>
//   e.g. node scripts/retain-immutable-assets.mjs build https://skyreader.app

import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const MAX_AGE_DAYS = Number(process.env.RETAIN_MAX_AGE_DAYS ?? 30);
const MANIFEST_PATH = '_app/retained-assets.json';
const IMMUTABLE_PREFIX = '_app/immutable/';
const DOWNLOAD_CONCURRENCY = 8;

const [buildDir, origin] = process.argv.slice(2);
if (!buildDir || !origin) {
  console.error('usage: retain-immutable-assets.mjs <build-dir> <live-origin>');
  process.exit(1);
}

/** All immutable asset paths in the freshly built output, relative to the build root. */
async function listCurrentBuildAssets() {
  const root = path.join(buildDir, IMMUTABLE_PREFIX);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(path.relative(buildDir, e.parentPath), e.name).replaceAll(path.sep, '/'));
}

async function fetchLiveManifest() {
  const res = await fetch(`${origin}/${MANIFEST_PATH}`, { redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${MANIFEST_PATH}: ${res.status}`);
  const manifest = await res.json();
  if (manifest?.version !== 1 || typeof manifest.assets !== 'object') {
    throw new Error(`unrecognized manifest shape at ${MANIFEST_PATH}`);
  }
  return manifest.assets;
}

/**
 * First-run bootstrap: the live deployment predates this script, so recover its
 * asset list from the service worker's injected precache manifest (entries look
 * like "_app/immutable/nodes/9.BZ8olZtr.js").
 */
async function bootstrapFromLiveServiceWorker() {
  const res = await fetch(`${origin}/service-worker.js`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET /service-worker.js: ${res.status}`);
  const sw = await res.text();
  const paths = [...new Set(sw.match(/_app\/immutable\/[^"'\\]+/g) ?? [])];
  const stamp = new Date().toISOString();
  return Object.fromEntries(paths.map((p) => [p, stamp]));
}

/** Download one carried asset from the live site into the build dir. */
async function download(assetPath) {
  const res = await fetch(`${origin}/${assetPath}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status}`);
  const dest = path.join(buildDir, assetPath);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  const current = await listCurrentBuildAssets();
  console.log(`current build: ${current.length} immutable assets`);

  let previous;
  try {
    previous = await fetchLiveManifest();
    if (previous === null) {
      console.log(
        'no retained-assets manifest on live site; bootstrapping from its service worker'
      );
      previous = await bootstrapFromLiveServiceWorker();
    }
  } catch (err) {
    console.warn(
      `WARNING: could not read live retention state (${err.message}); deploying without retained assets`
    );
    previous = {};
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const assets = Object.fromEntries(current.map((p) => [p, now.toISOString()]));

  const candidates = Object.entries(previous).filter(([p]) => !(p in assets));
  const carried = candidates.filter(([, lastShipped]) => new Date(lastShipped) >= cutoff);
  const expired = candidates.length - carried.length;
  if (expired > 0)
    console.log(`expired: ${expired} assets last shipped before ${cutoff.toISOString()}`);

  // Fetch carried assets that aren't already in the build, with a small worker pool.
  const toFetch = carried.filter(([p]) => !existsSync(path.join(buildDir, p)));
  let fetched = 0;
  const queue = [...toFetch];
  await Promise.all(
    Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const [assetPath, lastShipped] = item;
        try {
          await download(assetPath);
          assets[assetPath] = lastShipped;
          fetched++;
        } catch (err) {
          // Gone from the live site (e.g. predates retention) — drop it for good.
          console.warn(`WARNING: dropping ${assetPath}: fetch failed (${err.message})`);
        }
      }
    })
  );
  // Carried assets already on disk (e.g. re-run) keep their original stamp too.
  for (const [p, lastShipped] of carried) {
    if (!(p in assets) && existsSync(path.join(buildDir, p))) assets[p] = lastShipped;
  }

  const manifest = { version: 1, assets };
  await writeFile(path.join(buildDir, MANIFEST_PATH), JSON.stringify(manifest, null, 2));
  console.log(
    `retained: ${Object.keys(assets).length - current.length} assets from previous deploys (${fetched} downloaded)`
  );
}

await main();
