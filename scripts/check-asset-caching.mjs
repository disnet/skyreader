#!/usr/bin/env node
//
// Post-deploy assertion: /_app/immutable/* is served as a STATIC ASSET, not by the
// Pages Function.
//
// Why this needs its own check. functions/_middleware.ts is a root Pages Function,
// so without an explicit exclude it also intercepts build assets and rebuilds each
// response to attach CSP headers. That makes them dynamic Function output, which
// Cloudflare will not serve from the edge cache and for which _headers is ignored.
// Assets then fall back to the default 4h browser TTL *with* must-revalidate, so the
// edge never returns a clean HIT and every chunk costs an origin round trip —
// measured at ~800ms TTFB per file regardless of size. With ~170 precache entries
// that dominated service-worker download time on every deploy.
//
// Nothing else goes red when that regresses: the site still works, just slowly. So
// the invariant is asserted here, on the deployed origin, where it can actually be
// observed (static/_routes.json and static/_headers are consumed by Cloudflare and
// have no local effect).
//
// Two deterministic assertions, because they catch different halves:
//   1. Cache-Control says `immutable`  -> static/_headers was applied at all.
//   2. NO Content-Security-Policy header -> the Function did NOT handle this path.
//      The middleware adds CSP to every response it touches, so its presence on a
//      hashed asset is a direct signal that _routes.json's exclude stopped working.
//
// cf-cache-status is reported but NOT asserted: it legitimately reads MISS on the
// first request to a cold PoP, and tiered-cache behavior varies by colo. It is
// useful context in the log, not a stable pass/fail signal.
//
// Usage: node scripts/check-asset-caching.mjs <origin>
//   e.g. node scripts/check-asset-caching.mjs https://skyreader.app
//
// Deliberately dependency-free, and runnable by hand during an incident.

const [origin] = process.argv.slice(2);

if (!origin) {
  console.error('usage: check-asset-caching.mjs <origin>');
  process.exit(2);
}

const attempts = Number(process.env.SMOKE_ATTEMPTS || 6);
const delayMs = Number(process.env.SMOKE_DELAY_SECONDS || 10) * 1000;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_SECONDS || 20) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Find a real hashed asset by reading the deployed shell. Hardcoding a path is not
// an option: the filenames are content hashes and change every build.
async function findImmutableAsset() {
  const response = await fetch(origin, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`shell returned HTTP ${response.status}`);
  const html = await response.text();

  // kit.paths.relative makes these './_app/...' in the markup; normalize to absolute.
  const match = html.match(/\.?\/?(_app\/immutable\/[^"']+\.js)/);
  if (!match) throw new Error('no /_app/immutable/*.js reference found in the shell');
  return new URL(`/${match[1]}`, origin).toString();
}

let lastDetail = 'no attempt completed';

for (let attempt = 1; attempt <= attempts; attempt++) {
  console.log(`Asset caching check (${attempt}/${attempts}): ${origin}`);

  try {
    const assetUrl = await findImmutableAsset();
    const response = await fetch(assetUrl, { signal: AbortSignal.timeout(timeoutMs) });

    if (!response.ok) {
      lastDetail = `${assetUrl} returned HTTP ${response.status}`;
      console.log(`  ${lastDetail}`);
    } else {
      const cacheControl = response.headers.get('cache-control') || '';
      const csp = response.headers.get('content-security-policy');
      const cfStatus = response.headers.get('cf-cache-status') || '(none)';

      console.log(`  asset:          ${assetUrl}`);
      console.log(`  cache-control:  ${cacheControl || '(none)'}`);
      console.log(`  csp present:    ${csp ? 'YES' : 'no'}`);
      console.log(`  cf-cache-status:${cfStatus}   (informational)`);

      const problems = [];
      if (!cacheControl.includes('immutable')) {
        problems.push(
          `Cache-Control is ${JSON.stringify(cacheControl)}, expected it to include 'immutable' ` +
            '(static/_headers was not applied — check it is present in the build output)'
        );
      }
      if (csp) {
        problems.push(
          'a Content-Security-Policy header is present, which means functions/_middleware.ts ' +
            'handled this asset — check /_app/immutable/* is still excluded in static/_routes.json'
        );
      }

      if (problems.length === 0) {
        console.log('  OK: build assets are served statically with immutable caching');
        process.exit(0);
      }

      lastDetail = problems.join('; ');
      for (const problem of problems) console.log(`  PROBLEM: ${problem}`);
    }
  } catch (error) {
    lastDetail = `request failed: ${error instanceof Error ? error.message : String(error)}`;
    console.log(`  ${lastDetail}`);
  }

  if (attempt < attempts) await sleep(delayMs);
}

console.error(
  `FAIL: ${origin} is not serving build assets as cacheable static files (${lastDetail})`
);
process.exit(1);
