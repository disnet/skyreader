import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Deployed commit, served at `/_app/version.json` so the post-deploy smoke
    // check can assert this build is the one actually serving (see
    // frontend/svelte.config.js for the full rationale).
    ...(process.env.GITHUB_SHA ? { version: { name: process.env.GITHUB_SHA } } : {}),
    adapter: adapter({
      platformProxy: {
        persist: {
          path: '../backend/.wrangler/state/v3',
        },
      },
    }),
  },
};

export default config;
