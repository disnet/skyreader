import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';

// Client-side SPA route. `dev` is true only under `vite dev` and compiles to
// false in `npm run build`, so the whole /dev/* tree 404s in production.
export const ssr = false;

export function load() {
  if (!dev) error(404, 'Not found');
}
