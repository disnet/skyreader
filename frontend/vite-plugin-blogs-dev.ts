import type { Plugin, ViteDevServer } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Dev-only shim for the public linkblog pages.
//
// In production the `/blogs/*` routes are Cloudflare Pages Functions
// (functions/blogs/*). Vite's dev server (npm run dev / scripts/dev-local.sh)
// doesn't run Pages Functions, so without this they'd fall through to the SPA
// shell. This middleware invokes the SAME handler source in-process, keeping
// everything on :5173 (so OAuth and the existing /api proxy are untouched).
//
// It loads the handlers via ssrLoadModule, so edits to functions/blogs/* are
// picked up without restarting the dev server.

function loadDevVars(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const text = readFileSync(resolve(root, '.dev.vars'), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No .dev.vars — fall back to defaults below.
  }
  return env;
}

type BlogHandler = (context: {
  request: Request;
  env: Record<string, string | undefined>;
  params: Record<string, string>;
}) => Promise<Response>;

export function blogsDevPlugin(): Plugin {
  return {
    name: 'skyreader-blogs-dev',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      const devVars = loadDevVars(root);
      const env = {
        FEED_PROXY_URL: devVars.FEED_PROXY_URL || 'http://127.0.0.1:3000',
        FEED_PROXY_SECRET: devVars.FEED_PROXY_SECRET,
      };
      const origin = `http://127.0.0.1:${server.config.server.port ?? 5173}`;

      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url || '/', origin).pathname;
        if (req.method !== 'GET' || !pathname.startsWith('/blogs/')) return next();

        const rest = pathname.slice('/blogs/'.length).replace(/\/+$/, '');
        if (!rest) return next();
        const segs = rest.split('/').map((s) => decodeURIComponent(s));

        let modPath: string;
        let params: Record<string, string>;
        if (segs.length === 1) {
          modPath = '/functions/blogs/[id].ts';
          params = { id: segs[0] };
        } else if (segs.length === 2 && segs[1] === 'feed.xml') {
          // Static route wins over [rkey] in production; mirror that here.
          modPath = '/functions/blogs/[id]/feed.xml.ts';
          params = { id: segs[0] };
        } else if (segs.length === 2) {
          modPath = '/functions/blogs/[id]/[rkey].ts';
          params = { id: segs[0], rkey: segs[1] };
        } else {
          return next();
        }

        try {
          const mod = await server.ssrLoadModule(modPath);
          const handler = mod.onRequestGet as BlogHandler;
          const request = new Request(`${origin}${req.url}`, { method: 'GET' });
          const response = await handler({ request, env, params });

          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(await response.text());
        } catch (err) {
          console.error('[blogs-dev] failed to render', pathname, err);
          next(err as Error);
        }
      });
    },
  };
}
