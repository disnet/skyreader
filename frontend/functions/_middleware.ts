// Cloudflare Pages Function middleware for CSP with dynamic nonces
//
// This must NOT run for /_app/immutable/* and the other static asset paths. A
// path handled by a Function is dynamic output: Cloudflare won't serve it from
// the edge cache and _headers is ignored for it. That made every content-hashed
// chunk an origin round trip (~800ms each, even for a 600-byte file), which is
// what made service-worker precaching slow on deploy. static/_routes.json
// excludes those paths so Pages serves them directly as cacheable static assets.
//
// CSP is a document-level policy, so subresources lose nothing by skipping this.

// Belt-and-suspenders: if _routes.json is ever lost or mis-deployed, still don't
// reconstruct asset responses here — pass them through untouched so they stay
// cacheable rather than silently regressing to a Function-served round trip.
const STATIC_ASSET_PATH = /^\/(_app\/immutable|fonts|icons)\//;

export const onRequest: PagesFunction = async (context) => {
  const response = await context.next();

  if (STATIC_ASSET_PATH.test(new URL(context.request.url).pathname)) {
    return response;
  }

  const contentType = response.headers.get('content-type') || '';

  // Generate a random nonce for this request
  const nonce = btoa(crypto.randomUUID());

  // CSP directives with nonce for scripts
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // fonts.googleapis.com: collections-publication typography stylesheets (magazine view).
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' https: data:",
    "media-src 'self' https: data: blob:",
    "connect-src 'self' https://*.skyreader.app https:",
    // fonts.gstatic.com: the actual web-font files for the magazine view.
    "font-src 'self' data: https://fonts.gstatic.com",
    'frame-src https://www.youtube.com https://youtube.com https://www.youtube-nocookie.com https://youtube-nocookie.com https://player.vimeo.com',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const securityHeaders = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  };

  // For HTML responses, inject the nonce into script tags
  if (contentType.includes('text/html')) {
    const html = await response.text();
    // Add nonce to all script tags (handles <script>, <script type="module">, etc.)
    const modifiedHtml = html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);

    return new Response(modifiedHtml, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        ...Object.fromEntries(response.headers),
        ...securityHeaders,
        'Cache-Control': 'no-store', // Prevent caching so nonce in HTML matches CSP header
      },
    });
  }

  // Non-HTML responses: just add security headers
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      ...Object.fromEntries(response.headers),
      ...securityHeaders,
    },
  });
};
