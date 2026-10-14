import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// The /dev/* component harness is a local-only playground. src/routes/dev/+layout.ts
// already 404s the whole tree in production, but that's a runtime guard — the page
// code still got compiled, shipped, and (worse) precached onto every user's device
// by the service worker, since the SW precaches the entire client build.
//
// Replacing each dev +page.svelte with an empty component at build time removes the
// bodies and lets their harness/fixture imports tree-shake away. The route nodes
// themselves still exist, so SvelteKit's manifest and the +layout.ts 404 guard are
// untouched — behavior in production is identical, minus the dead weight.
function stripDevRoutes(): Plugin {
  const DEV_PAGE = /\/src\/routes\/dev\/.*\+page\.svelte$/;
  return {
    name: 'skyreader:strip-dev-routes',
    // Build only: `vite dev` must keep serving the real harness.
    apply: 'build',
    // Ahead of vite-plugin-svelte, so it compiles the stub instead of the source.
    enforce: 'pre',
    load(id) {
      if (DEV_PAGE.test(id.split('?')[0])) {
        return '<!-- dev route stripped from production build -->';
      }
      return null;
    },
  };
}

// PDF.js's image decoders for the original-PDF view (components/feed/PdfViewer):
// OpenJPEG (JPEG 2000), JBIG2 (black-and-white scans), and QCMS (ICC colour).
// PDF.js loads each from its `wasmUrl` option by a fixed filename, as WebAssembly
// or, failing that, as the JS fallback beside it, so they can't go through Vite's
// hashed asset pipeline. They're copied verbatim to a versioned directory under
// _app/immutable (cacheable forever, and outside the CSP the Pages middleware
// adds), which PdfViewer derives from PDF.js's own `version`. Served from
// node_modules in dev. Kept out of the service worker's precache (see
// globIgnores): fetched only when a PDF actually holds such an image.
const PDFJS_DIR = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
const PDFJS_VERSION: string = JSON.parse(readFileSync(`${PDFJS_DIR}package.json`, 'utf8')).version;
const PDFJS_DECODERS_PATH = `_app/immutable/pdfjs/${PDFJS_VERSION}/`;
const PDFJS_DECODERS = [
  'jbig2.wasm',
  'jbig2_nowasm_fallback.js',
  'openjpeg.wasm',
  'openjpeg_nowasm_fallback.js',
  'qcms_bg.wasm',
];

function pdfjsDecoders(): Plugin {
  let ssr = false;
  const read = (name: string) => readFileSync(`${PDFJS_DIR}wasm/${name}`);
  return {
    name: 'skyreader:pdfjs-decoders',
    configResolved(config) {
      ssr = Boolean(config.build.ssr);
    },
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_DECODERS_PATH}`, (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '');
        if (!PDFJS_DECODERS.includes(name)) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
        );
        res.end(read(name));
      });
    },
    generateBundle() {
      if (ssr) return;
      for (const name of PDFJS_DECODERS) {
        this.emitFile({
          type: 'asset',
          fileName: `${PDFJS_DECODERS_PATH}${name}`,
          source: read(name),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    stripDevRoutes(),
    pdfjsDecoders(),
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
        // PDF.js's image decoders (see pdfjsDecoders): fetched on demand, by the
        // few PDFs that need them, rather than installed on every device.
        globIgnores: ['client/_app/immutable/pdfjs/**'],
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
