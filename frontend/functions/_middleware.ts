// Cloudflare Pages Function middleware for CSP with dynamic nonces

export const onRequest: PagesFunction = async (context) => {
  const response = await context.next();
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
