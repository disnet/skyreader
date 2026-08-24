import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

const alias = {
  $lib: path.resolve(__dirname, 'src/lib'),
  // SvelteKit's virtual modules don't exist outside its build; the stub is what
  // lets a module that reads `browser`/`dev`/`version` be unit tested at all.
  '$app/environment': path.resolve(__dirname, 'test/stubs/app-environment.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        // Plain unit tests (node environment). Rune modules are excluded: they
        // need the Svelte compiler, so their tests run in the project below.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.component.test.ts', 'src/**/*.svelte.test.ts'],
        },
        resolve: { alias },
      },
      {
        // Everything that needs the Svelte compiler, in jsdom: components mounted
        // from .svelte files, and the rune-based stores/hooks in .svelte.ts modules
        // (an uncompiled $state() is just an undefined identifier).
        plugins: [svelte({ hot: false })],
        test: {
          name: 'component',
          include: ['src/**/*.component.test.ts', 'src/**/*.svelte.test.ts'],
          environment: 'jsdom',
        },
        resolve: { alias, conditions: ['browser'] },
      },
    ],
  },
});
