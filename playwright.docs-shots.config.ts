import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

// Documentation screenshots (`npm run shots:docs`). Rides the e2e stack — same
// servers, same global setup, same seeded-user fixtures — but the specs in
// e2e-docs/ produce PNGs for docs-site/src/assets/screenshots/ instead of
// asserting behavior. Rerun whenever the design changes; the docs commit the
// regenerated images.
export default defineConfig({
  ...baseConfig,
  testDir: './e2e-docs',
  retries: 0,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // A fixed viewport and 2x scale so shots are stable between runs and
        // crisp on retina screens. Wide enough for the desktop layout, tall
        // enough that each captured region fits without scrolling mid-shot.
        viewport: { width: 1200, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: 'light',
      },
    },
  ],
});
