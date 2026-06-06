import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: adapter(),

    // Strict CSP for a read-only public site. SvelteKit auto-injects a nonce for
    // its own (dynamic) hydration script; our only interactive code — the
    // subscribe button — ships as a bundled module under script-src 'self'.
    //
    // connect-src lists the backend API origins the subscribe button talks to
    // (prod, staging, and the local dev backend). They're cross-origin: this app
    // lives on linkblogs.skyreader.app, the API on api.skyreader.app. The
    // localhost entry is inert in production.
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self'],
        'img-src': ['self', 'https:', 'data:'],
        'connect-src': [
          'self',
          'https://api.skyreader.app',
          'https://api-staging.skyreader.app',
          'http://127.0.0.1:8787',
        ],
        'font-src': ['self', 'data:'],
        'frame-ancestors': ['none'],
        'base-uri': ['self'],
        'form-action': ['self'],
        'object-src': ['none'],
      },
    },
  },
};

export default config;
