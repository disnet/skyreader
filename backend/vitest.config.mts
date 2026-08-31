import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Test ES256 key pair for OAuth confidential client testing
// This key is ONLY for testing - production uses a secret managed via wrangler secret
const TEST_CLIENT_SIGNING_KEY = JSON.stringify({
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
  kid: 'test-key-001',
});

// vitest-pool-workers 0.22 dropped the `/config` entrypoint and the
// `test.poolOptions.workers` block: the integration is a Vite plugin now, and the
// config itself is a plain `defineConfig`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          CLIENT_SIGNING_KEY: TEST_CLIENT_SIGNING_KEY,
          // Pin the ambient vars the suite depends on. Without these, tests
          // inherit wrangler.toml's PRODUCTION values in CI and whatever the
          // developer's .dev.vars says locally — so the same test can pass in
          // one place and fail in the other.
          //
          // FEED_PROXY_URL pointed at the live Fly proxy in CI, and the save
          // path extracts article content through it inside ctx.waitUntil.
          // waitOnExecutionContext blocks on that, so a slow proxy (it is
          // known-overloaded) blew the 5s test timeout and took the whole
          // file's isolated storage down with it. A refused port fails
          // instantly and keeps unit tests off the network entirely; any test
          // that needs a proxy response stubs fetch itself.
          FEED_PROXY_URL: 'http://127.0.0.1:1',
          // Assertions hardcode the production linkblog base, which only held
          // on a machine with no .dev.vars.
          LINKBLOG_PUBLIC_URL: 'https://linkblogs.skyreader.app',
          // Polar billing: fixed test values so the webhook signature tests and
          // checkout handler don't depend on the developer's .dev.vars. The
          // secret is an opaque string (its UTF-8 bytes are the HMAC key — see
          // services/polar.ts); checkout tests stub fetch, so the token never
          // leaves the process.
          POLAR_WEBHOOK_SECRET: 'test-polar-webhook-secret',
          POLAR_PRODUCT_ID: 'prod-test',
          POLAR_ACCESS_TOKEN: 'polar-test-token',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    // vitest 4's `vi.spyOn` returns the *existing* mock when a method is already
    // spied, instead of wrapping it in a fresh one. Without a restore between
    // tests, a second `vi.spyOn(x, 'y')` in the same file hands back the previous
    // test's spy, call history and all — so `not.toHaveBeenCalled()` sees the
    // earlier test's calls. Restoring after each test is what the suite always
    // assumed.
    restoreMocks: true,
  },
});
