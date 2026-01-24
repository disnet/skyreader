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
			// Service worker doesn't work in dev mode on Firefox due to ES module restrictions.
			// Use `npm run build && npm run preview` to test the service worker.
			register: process.env.NODE_ENV === 'production',
		},
		// CSP is handled by:
		// - Dev: hooks.server.ts
		// - Production: functions/_middleware.ts
	},
};

export default config;
