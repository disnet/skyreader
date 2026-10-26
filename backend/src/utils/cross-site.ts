import { parseCookies, SESSION_COOKIE_NAME } from './cookies';

// Cross-site request forgery guard.
//
// The session cookie's SameSite=Lax used to be the only thing stopping another
// site from making a reader's browser send writes to the API: CORS decides who may
// READ a response, not whether a request lands, and routes parse bodies with
// request.json() whatever the content type, so a `no-cors` text/plain POST would
// be accepted. A workspace frame's sign-in uses a SameSite=None cookie
// (routes/frame-sign-in.ts), and Lax alone is a thin wall anyway, so writes that
// carry a session cookie are refused when the browser says they come from
// another site.
//
// Only cookie-bearing requests are checked: a request with no session cookie
// can't act as anyone (bearer-token, service-auth and webhook calls are
// authenticated by what they carry, not by ambient cookies).

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isCrossSiteWrite(request: Request, allowedOrigins: string[]): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  if (!parseCookies(request.headers.get('Cookie')).has(SESSION_COOKIE_NAME)) return false;

  // Origin and Sec-Fetch-Site are set by the browser, not by page script.
  const origin = request.headers.get('Origin');
  // The save extension posts from its own origin with the reader's cookie
  // (extension/background.js). Browsers differ on the Sec-Fetch-Site they give
  // extension requests, so they're recognized by origin; no web page can send one.
  if (origin && /^(chrome|moz|safari-web)-extension:\/\//.test(origin)) return false;

  // `same-site` covers every *.skyreader.app origin (and 127.0.0.1 across ports
  // in dev); `none` is a navigation the user started.
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite) return fetchSite === 'cross-site';

  // Older browsers without Fetch Metadata: fall back to Origin. A web origin
  // that isn't one of ours is cross-site, and so is `null` (a sandboxed frame,
  // a cross-origin redirect); no Origin at all passes.
  if (!origin) return false;
  if (origin === 'null') return true;
  return /^https?:\/\//.test(origin) && !allowedOrigins.includes(origin);
}
