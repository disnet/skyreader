import { test, expect } from '@playwright/test';
import { shellRendered, waitForControl } from './helpers';

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

  // The real update path: a new SW BUILD must (1) self-activate and claim the open
  // page with no user action (skipWaiting in install + clientsClaim — the recovery
  // property), and (2) surface the update banner. The banner is gated on the
  // controlling worker reporting a build version different from the one this page is
  // running (GET_VERSION message in service-worker.ts, checked on controllerchange in
  // +layout.svelte). A same-build re-claim must NOT prompt — see the next test.
  //
  // We simulate a genuinely different build with a fixture worker (e2e-fixture-sw.js,
  // staged into the served dir by playwright.pwa.config.ts) that self-activates,
  // claims, and reports a distinct version.
  test('a new SW BUILD claims the page and shows the update banner', async ({ page }) => {
    await page.goto('/');
    await waitForControl(page);

    const claimed = await page.evaluate(async () => {
      const swapped = new Promise<boolean>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), {
          once: true,
        });
        setTimeout(() => resolve(false), 15000);
      });
      await navigator.serviceWorker.register('/e2e-fixture-sw.js');
      return swapped;
    });
    expect(claimed, 'new worker should activate and claim the page without user action').toBe(true);

    // A different build now controls the page → offer the update.
    await expect(page.locator('.update-banner')).toBeVisible();

    // Applying the update is a plain reload.
    await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('.update-btn').click()]);
    expect(await shellRendered(page)).toBe(true);
  });

  // Regression: on mobile, opening a link (new tab / in-app browser sheet) backgrounds
  // the PWA; returning can fire controllerchange while the SAME build still controls
  // the page. That must NOT surface a "new version available" banner. Registering a
  // byte-different script URL for the real SW installs a worker with IDENTICAL build
  // version — the exact same-version re-claim, without a deploy.
  test('a same-build re-claim (mobile resume) does NOT show the update banner', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForControl(page);

    const claimed = await page.evaluate(async () => {
      const swapped = new Promise<boolean>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), {
          once: true,
        });
        setTimeout(() => resolve(false), 15000);
      });
      await navigator.serviceWorker.register('/service-worker.js?deploy=2');
      return swapped;
    });
    expect(claimed, 'the re-registered worker should still claim the page').toBe(true);

    // Give the controllerchange handler's version round-trip time to resolve, then
    // confirm it stayed silent — the controlling build equals the running build.
    await page.waitForTimeout(1500);
    await expect(page.locator('.update-banner')).toBeHidden();
  });
});
