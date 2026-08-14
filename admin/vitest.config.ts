import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Deliberately not the SvelteKit vite config: these are plain unit tests over the
// metric/query modules, and loading the kit plugin starts a dev server that then
// refuses to shut down after the run. `$lib` is the only thing the plugin
// provided that the tests need.
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
