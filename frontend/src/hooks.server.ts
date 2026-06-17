import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';

// Dev mode: use 'unsafe-inline' for scripts (acceptable for local development)
// Production: functions/_middleware.ts handles CSP with proper nonces

const devCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // unsafe-inline OK for local dev
  // fonts.googleapis.com: collections-publication typography stylesheets (magazine view).
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' https: data:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self' http://127.0.0.1:8787 ws://127.0.0.1:5173 https:",
  // fonts.gstatic.com: the actual web-font files for the magazine view.
  "font-src 'self' data: https://fonts.gstatic.com",
  'frame-src https://www.youtube.com https://youtube.com https://www.youtube-nocookie.com https://youtube-nocookie.com https://player.vimeo.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Only set CSP in dev - production uses middleware
  if (dev) {
    response.headers.set('Content-Security-Policy', devCsp);
  }

  // Security headers for all environments
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  return response;
};
