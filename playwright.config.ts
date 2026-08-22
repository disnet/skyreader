import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The backend reads FEED_PROXY_SECRET from backend/.dev.vars, and feed ingest is
// fail-closed, so the proxy has to start with that same value or every fetch
// 401s and the timeline stays empty. Read it from the file rather than pinning a
// literal here: CI writes test-e2e-secret into .dev.vars, and a local dev setup
// keeps whatever dev-local.sh uses.
function feedProxySecret(): string {
  try {
    const vars = readFileSync(new URL('./backend/.dev.vars', import.meta.url), 'utf8');
    return vars.match(/^FEED_PROXY_SECRET=(.*)$/m)?.[1].trim() || 'test-e2e-secret';
  } catch {
    return 'test-e2e-secret';
  }
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // A retry on CI turns a rare flake into a warning instead of a red build, and
  // it's what makes `trace: 'on-first-retry'` produce anything at all.
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  timeout: 30_000,

  globalSetup: './e2e/global-setup.ts',

  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: 'bun run dev',
      cwd: './feed-proxy',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 10_000,
      env: { PROXY_SECRET: feedProxySecret(), PORT: '3000' },
    },
    {
      command: 'npm run dev',
      cwd: './backend',
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'npm run dev',
      cwd: './frontend',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
