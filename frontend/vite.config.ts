import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit(),
    SvelteKitPWA({
      // injectManifest lets us keep a hand-written service worker for our custom
      // message / sync / periodicsync handlers, while Workbox injects a complete,
      // build-versioned precache manifest (self.__WB_MANIFEST) for atomic shell+chunk
      // caching. @vite-pwa/sveltekit reads SvelteKit's own built service worker, so the
      // source MUST live at SvelteKit's conventional path: src/service-worker.ts.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.js',

      // SvelteKit 2 defaults kit.paths.relative = true, so adapter-static sets Vite's
      // base to './'. @vite-pwa/sveltekit inherits that and would register the SW with
      // a RELATIVE url+scope ('./service-worker.js', scope './'). The registration runs
      // from inside the app bundle on whatever route the SW first installs on — e.g.
      // '/auth/callback' right after OAuth. workbox-window then resolves './' against
      // that path, asking for '/auth/service-worker.js' with scope '/auth/'. No such
      // file exists, the SPA host serves the index.html fallback, and the browser tries
      // to install an HTML document as a worker → "error during installation" (and, when
      // it does load, a uselessly narrow '/auth/' scope). Pin both absolute so the worker
      // is always '/service-worker.js' with root scope no matter which route registers it.
      scope: '/',
      buildBase: '/',

      // The worker self-activates (skipWaiting in install + clientsClaim) so a fix can
      // reach clients even when the old app can't boot. 'prompt' here only means the
      // register module won't reload the page on its own; the update banner is driven
      // by a controllerchange listener in +layout.svelte (the workbox-window 'waiting'
      // event the prompt flow normally uses never fires when skipWaiting runs in
      // install). That listener confirms the new controller is a different build
      // before prompting, so a spurious controllerchange on mobile resume doesn't
      // surface a false "new version available" banner.
      registerType: 'prompt',

      // We register the SW ourselves via useRegisterSW() inside the app bundle, so the
      // registration runs under our nonce'd, strict-dynamic CSP. Do not inject a script tag.
      injectRegister: false,

      // The web app manifest is hand-maintained at static/manifest.json and linked from
      // the layout <head>; don't let the plugin generate/inject a competing one.
      manifest: false,

      kit: {
        // adapter-static is a pure SPA (fallback: 'index.html'). The plugin precaches
        // the navigation shell as a single manifest entry whose revision tracks the
        // build version. fallbackMapping: '/' makes that entry's URL '/' instead of the
        // default 'index.html' — critical because the install-time precache FETCH uses
        // this URL, and hosts (vite preview, Cloudflare Pages) serve the SPA shell at
        // '/' but may 404 on '/index.html'. A 404 there rejects the whole install and
        // the worker never activates. '/' is served universally, so install succeeds.
        spa: { fallbackMapping: '/' },
        adapterFallback: 'index.html',
      },

      injectManifest: {
        // Precache the full client build so any single SW version always holds a
        // complete, self-consistent set of hashed JS/CSS chunks + static assets. The
        // SPA shell (index.html) is added to the manifest separately by kit.spa above,
        // so it is NOT globbed here (no prerendered/ dir exists in a pure SPA).
        globPatterns: ['client/**/*.{js,css,ico,png,svg,webp,webmanifest}'],
      },

      devOptions: {
        // The injectManifest SW is only built for production. Test it via build + preview.
        enabled: false,
        type: 'module',
      },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
