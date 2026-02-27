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
          },
        },
      },
    },
  },
});
