import { defineConfig, devices } from '@playwright/test';

// PWA / service-worker E2E. SEPARATE from the main playwright.config.ts because the
// service worker only exists in a PRODUCTION build — the main config runs dev servers
// where the SW is disabled (vite.config.ts devOptions.enabled=false). This config
// builds the frontend and serves it via `vite preview` on :4173, with no backend
// (PWA boot/offline behavior does not depend on the API).
//
// Run on chromium AND webkit. webkit shares Safari's engine and is the closest
// available proxy for the iOS Safari issues this restructure targets — but it is NOT
// a true installed iOS PWA, so real-device testing is still required.
//
// Prereq: npx playwright install chromium webkit
export default defineConfig({
  testDir: './e2e-pwa',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],

  webServer: {
    // Build a fresh production bundle, then serve it. Locally (reuseExistingServer) a
    // preview already running on :4173 is reused — restart it after a rebuild to avoid
    // testing a stale bundle. In CI the bundle is always built fresh.
    //
    // The `cp` stages the SW update-fixture into the served client dir (vite preview
    // serves .svelte-kit/output/client, and sirv only indexes files present at
    // startup). It's a test-only file — it never ships to production and the app never
    // registers it — used to simulate a genuinely new build in service-worker.spec.ts.
    command:
      'npm run build && cp ../e2e-pwa/fixtures/e2e-fixture-sw.js .svelte-kit/output/client/ && npm run preview -- --port 4173 --host 127.0.0.1',
    cwd: './frontend',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
