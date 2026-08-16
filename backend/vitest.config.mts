import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

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

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
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
          },
        },
      },
    },
  },
});
