import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd, the Workers runtime, so they prove pdf.js parses
// there and not just under Node.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { EXTRACT_SECRET: 'test-secret' } },
    }),
  ],
});
