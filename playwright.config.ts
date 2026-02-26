import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
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
      env: { PROXY_SECRET: 'test-e2e-secret', PORT: '3000' },
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
