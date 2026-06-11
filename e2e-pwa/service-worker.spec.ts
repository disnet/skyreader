import { test, expect } from '@playwright/test';
import { waitForControl } from './helpers';

test.describe('service worker lifecycle', () => {
  test('registers, precaches the full build, activates, and controls the page', async ({
    page,
  }) => {
    await page.goto('/');
    const state = await waitForControl(page);
    expect(state.activeState).toBe('activated');
    expect(state.controller).toBe(true);

    const precache = await page.evaluate(async () => {
      const keys = await caches.keys();
      const name = keys.find((k) => /precache/i.test(k));
      if (!name) return { name: null, count: 0 };
      return { name, count: (await (await caches.open(name)).keys()).length };
    });
    expect(precache.name).toBeTruthy();
    // The shell + every hashed chunk + icons, cached as one complete, self-consistent set.
    expect(precache.count).toBeGreaterThan(50);
  });

  test('no skew: the served shell only references precached chunks', async ({
    browserName,
    page,
  }) => {
    test.skip(browserName !== 'chromium', 'Cache/shell introspection is most reliable on chromium');
    await page.goto('/');
    await waitForControl(page);

    const result = await page.evaluate(async () => {
      const keys = await caches.keys();
      const name = keys.find((k) => /precache/i.test(k));
      if (!name) return { ok: false, reason: 'no precache cache found' };
      const cache = await caches.open(name);
      const reqs = await cache.keys();
      // Pathnames of everything precached (chunk keys are plain paths; the shell key
      // carries a ?__WB_REVISION__ param, so compare by pathname throughout).
      const cachedPaths = new Set(reqs.map((r) => new URL(r.url).pathname));
      // The precached app shell that all navigations are served from.
      const shellReq = reqs.find((r) => new URL(r.url).pathname === '/');
      if (!shellReq) return { ok: false, reason: 'shell "/" not found in precache' };
      const html = await (await cache.match(shellReq))!.text();
      // The entry chunks the shell loads (start/app + any modulepreloads). The shell may
      // reference them relatively ("_app/…") or absolutely ("/_app/…"); normalize to the
      // absolute pathname so it can be compared against the precache keys either way.
      const refs = [
        ...new Set([...html.matchAll(/_app\/immutable\/[^"')\s]+\.js/g)].map((m) => '/' + m[0])),
      ];
      const missing = refs.filter((ref) => !cachedPaths.has(ref));
      return { ok: true, refCount: refs.length, missing };
    });

    expect(result.ok, result.reason).toBeTruthy();
    expect(result.refCount, 'shell should reference at least one chunk').toBeGreaterThan(0);
    expect(
      result.missing,
      `shell references chunks absent from precache: ${result.missing?.join(', ')}`
    ).toEqual([]);
  });

  test('serves stale immutable chunks from retained caches', async ({ page }) => {
    await page.goto('/');
    await waitForControl(page);

    const result = await page.evaluate(async () => {
      const staleUrl = '/_app/immutable/chunks/stale-client-test.js';
      const body = 'export const staleClientTest = true;';
      const cache = await caches.open('workbox-precache-stale-client-test');
      await cache.put(
        staleUrl,
        new Response(body, {
          headers: { 'content-type': 'application/javascript' },
        })
      );

      const response = await fetch(staleUrl);
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      body: 'export const staleClientTest = true;',
    });
  });
});
