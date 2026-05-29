import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: true,
    }),
    serviceWorker: {
      // Disable SvelteKit's built-in service worker handling — @vite-pwa/sveltekit
      // (configured in vite.config.ts) now owns the service worker, its registration,
      // and precaching. Leaving this on would produce a second, conflicting SW.
      register: false,
    },
    // CSP is handled by:
    // - Dev: hooks.server.ts
    // - Production: functions/_middleware.ts
  },
};

export default config;
