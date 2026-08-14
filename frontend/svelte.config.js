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
    // Stamp the build with the commit being deployed. SvelteKit writes this to
    // `/_app/version.json`, which gives the Pages apps the same post-deploy proof
    // the Workers get: the smoke check asserts the served version *is* the SHA CI
    // just built, so a deploy that silently didn't roll out goes red instead of
    // passing a content sniff against markup that never changes.
    //
    // It's also the version the service worker compares for deploy-vs-spurious
    // controllerchange (src/service-worker.ts), which needs it unique per build —
    // a commit SHA is. Local/manual builds fall back to SvelteKit's timestamp.
    ...(process.env.GITHUB_SHA ? { version: { name: process.env.GITHUB_SHA } } : {}),
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
