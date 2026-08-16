#!/usr/bin/env node
//
// Post-deploy smoke check. Run right after a deploy step so a green workflow means
// "production is serving this commit", not "the test suite passed".
//
// Usage:
//   node scripts/smoke-check.mjs <url> --version <sha>    # JSON health: 200 + .version === sha
//   node scripts/smoke-check.mjs <url> --contains <text>  # static site: 200 + body contains text
//
// Retries, because a fresh deploy takes a few seconds to propagate. Exits non-zero
// (and loudly) once the attempts run out.
//
// Deliberately dependency-free: node is on every runner, and this stays runnable
// by hand during an incident.

const [url, mode, expected] = process.argv.slice(2);

if (!url || (mode !== '--version' && mode !== '--contains') || !expected) {
  console.error('usage: smoke-check.mjs <url> --version <sha> | --contains <text>');
  process.exit(2);
}

const attempts = Number(process.env.SMOKE_ATTEMPTS || 6);
const delayMs = Number(process.env.SMOKE_DELAY_SECONDS || 10) * 1000;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_SECONDS || 20) * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastDetail = 'no attempt completed';

for (let attempt = 1; attempt <= attempts; attempt++) {
  console.log(`Smoke check (${attempt}/${attempts}): ${url}`);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Cache-Control': 'no-cache' },
    });
    const body = await response.text();

    if (!response.ok) {
      lastDetail = `HTTP ${response.status}`;
      console.log(`  ${lastDetail}`);
    } else if (mode === '--contains') {
      if (body.includes(expected)) {
        console.log(`  OK: 200 and body contains ${JSON.stringify(expected)}`);
        process.exit(0);
      }
      lastDetail = `200 but body does not contain ${JSON.stringify(expected)}`;
      console.log(`  ${lastDetail}`);
    } else {
      let version;
      try {
        version = JSON.parse(body).version;
      } catch {
        version = undefined;
      }
      if (version === expected) {
        console.log(`  OK: 200 and version matches ${expected}`);
        process.exit(0);
      }
      lastDetail = `200 but version is ${JSON.stringify(version)}, expected ${expected}`;
      console.log(`  ${lastDetail}`);
    }
  } catch (error) {
    lastDetail = `request failed: ${error instanceof Error ? error.message : String(error)}`;
    console.log(`  ${lastDetail}`);
  }

  if (attempt < attempts) await sleep(delayMs);
}

console.error(`FAIL: ${url} did not converge to the expected deploy (${lastDetail})`);
process.exit(1);
