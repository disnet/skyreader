/**
 * Lets Node import the backend's TypeScript sources as-is.
 *
 * Node strips types happily, but its ESM resolver demands file extensions, and
 * the backend (bundled by Wrangler/esbuild) writes extensionless relative
 * imports — `import { ... } from './refs'`. This hook retries a failed relative
 * resolution with `.ts`, then `/index.ts`.
 *
 * Loaded with `node --import ./ts-resolve.mjs`; see package.json's scripts.
 */

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // try the next shape
        }
      }
      throw error;
    }
  },
});
