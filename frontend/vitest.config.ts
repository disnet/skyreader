import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

const alias = { $lib: path.resolve(__dirname, 'src/lib') };

export default defineConfig({
  test: {
    projects: [
      {
        // Plain unit tests (node environment).
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.component.test.ts'],
        },
        resolve: { alias },
      },
      {
        // Component tests: compile .svelte files and mount them in jsdom.
        plugins: [svelte({ hot: false })],
        test: {
          name: 'component',
          include: ['src/**/*.component.test.ts'],
          environment: 'jsdom',
        },
        resolve: { alias, conditions: ['browser'] },
      },
    ],
  },
});
