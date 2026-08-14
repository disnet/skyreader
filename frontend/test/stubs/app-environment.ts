// Stands in for SvelteKit's `$app/environment` in unit tests, which run outside
// the SvelteKit build and so can't resolve it. Aliased in vitest.config.ts.
//
// The values describe a *production browser*, because that is the only
// configuration in which the code under test (client error reporting) does
// anything at all.

export const browser = true;
export const dev = false;
export const building = false;
export const version = 'test-build-sha';
