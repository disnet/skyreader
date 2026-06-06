import type { Handle } from '@sveltejs/kit';

// CSP is owned by SvelteKit's kit.csp config (svelte.config.js) — it injects the
// policy with a per-request nonce for the hydration script. Here we add the
// remaining security headers for every response.
export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );

  return response;
};
