<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { writable, type Writable } from 'svelte/store';
  import type { Component, Snippet } from 'svelte';
  import { useRegisterSW } from 'virtual:pwa-register/svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import Logo from '$lib/assets/logo.svg';
  import '../app.css';

  let { children } = $props();
  let updating = $state(false);

  // The authenticated app shell is code-split: it (and its heavy dependency graph —
  // the IndexedDB data layer, feed stores, Sidebar, @mention polling) is fetched
  // dynamically, only once the user is authenticated. A logged-out visitor downloads
  // just this layout plus the landing page, not the whole app.
  let AppShell = $state<Component<{ children: Snippet }> | null>(null);
  $effect(() => {
    if (browser && auth.isAuthenticated && !AppShell) {
      import('$lib/components/AppShell.svelte').then((m) => {
        AppShell = m.default;
      });
    }
  });

  // Service worker registration + update detection, handled by @vite-pwa/sveltekit's
  // workbox-window wrapper. The worker self-activates after a complete precache
  // (skipWaiting in install + clientsClaim), so a broken active worker can't strand
  // users before this layout boots. That also means workbox-window's 'waiting' event
  // — the usual prompt-mode banner signal — never fires (it requires a worker to sit
  // in the waiting state for 200ms). The one signal that fires on EVERY update,
  // including ones found at load time and the Nth deploy onto a long-lived iOS PWA,
  // is `controllerchange`: the new worker claiming this page. So the banner hangs
  // off controllerchange, and applying the update is just a reload — the new shell
  // and chunks come from the already-active worker's precache.
  // In dev there's no SW (devOptions.enabled = false), so this is an inert no-op.
  //
  // useRegisterSW() is NOT SSR-safe in this version: it synchronously calls register(),
  // whose `"serviceWorker" in navigator` check throws when `navigator` is undefined.
  // adapter-static prerenders the SPA shell at build time, so guard on `browser` and
  // fall back to inert stores during prerender — otherwise the build crashes.
  let needRefresh: Writable<boolean> = writable(false);
  if (browser) {
    ({ needRefresh } = useRegisterSW({
      // The library's prompt path (taken when an update is classified "external")
      // auto-reloads on controllerchange unless onNeedReload is supplied. Route it
      // to the banner instead of yanking a mid-read reload.
      onNeedReload() {
        needRefresh.set(true);
      },
      onRegisteredSW(_swScriptUrl, registration) {
        if (!registration) return;
        // Poll for a newer SW hourly, and whenever the tab regains focus —
        // the latter covers iOS PWAs resuming from a long background idle.
        setInterval(() => registration.update(), 60 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') registration.update();
        });
      },
      onRegisterError(error) {
        console.error('Service worker registration failed:', error);
      },
    }));

    if ('serviceWorker' in navigator) {
      // True on a normal load of an installed PWA; false on first-ever visit, where
      // the initial worker's clientsClaim() fires controllerchange but the page is
      // already running the build that worker precached — no banner needed.
      let hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) needRefresh.set(true);
        hadController = true;
      });
    }
  }

  function applyUpdate() {
    updating = true;
    // The new worker is already active and controlling; reloading serves the new
    // shell + chunks from its precache.
    window.location.reload();
  }

  // Dev only: tear down any service worker left registered by a previous production
  // build / `npm run preview`, so it can't serve stale cached assets over Vite's dev
  // server. (vite-plugin-pwa doesn't register a SW in dev with devOptions disabled.)
  onMount(() => {
    if (browser && import.meta.env.DEV && 'serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => registrations.forEach((reg) => reg.unregister()));
    }
  });
</script>

<svelte:head>
  <title>Skyreader</title>
  <meta
    name="description"
    content="A reading app that helps you make sense of what you read — everything from everywhere in one calm place."
  />
  <link rel="icon" type="image/svg+xml" href={Logo} />
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#4A9FD4" />
</svelte:head>

<Toast />

{#if $needRefresh}
  <div class="update-banner">
    {#if updating}
      <span>Updating...</span>
    {:else}
      <span>A new version of Skyreader is available.</span>
      <button class="update-btn" onclick={applyUpdate}> Update </button>
    {/if}
  </div>
{/if}

<div class="app">
  {#if $page.url.pathname === '/auth/callback' || $page.url.pathname === '/save' || $page.url.pathname === '/subscribe'}
    <!-- Transient bounce/action pages rendered bare so no app (or marketing)
         chrome flashes: the OAuth callback before it redirects on, and the
         /save and /subscribe share-targets, which run a single action and show
         a confirmation. -->
    {@render children()}
  {:else if !auth.isLoading}
    {#if auth.isAuthenticated}
      {#if AppShell}
        <AppShell {children} />
      {:else}
        <div class="loading">Loading...</div>
      {/if}
    {:else}
      <header class="header-full">
        <div class="header-content">
          <a href="/" class="logo">
            <img src={Logo} alt="" class="logo-icon" />
            <span>Skyreader</span>
          </a>
          <a
            href="https://userinput.app/#/s/did:plc:ra4jsemddo2ii4pn5jaf6x4v/3mobgsd6d5n27"
            class="feedback-link"
            target="_blank"
            rel="noopener noreferrer">Feedback ↗</a
          >
          <a href="/auth/login" class="login-btn">Login</a>
        </div>
      </header>

      <main class="main-full">
        {@render children()}
      </main>
      <footer class="app-footer">
        <a href="/terms">Terms</a>
        <span class="separator">·</span>
        <a href="mailto:abuse@skyreader.app">Report Abuse</a>
        <span class="separator">·</span>
        <a
          href="https://userinput.app/#/s/did:plc:ra4jsemddo2ii4pn5jaf6x4v/3mobgsd6d5n27"
          target="_blank"
          rel="noopener noreferrer">Feedback</a
        >
      </footer>
    {/if}
  {:else}
    <div class="loading">Loading...</div>
  {/if}
</div>

<style>
  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .header-full {
    background: var(--color-bg-secondary, #f5f5f5);
    border-bottom: 1px solid var(--color-border, #e0e0e0);
    padding: 0.75rem 1rem;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-content {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: var(--weight-bold);
    font-size: var(--text-2xl);
    color: var(--color-primary, #0066cc);
    text-decoration: none;
  }

  .logo-icon {
    width: 28px;
    height: 28px;
  }

  .feedback-link {
    color: var(--color-text-secondary, #666);
    text-decoration: none;
    font-size: var(--text-md);
    margin-left: auto;
  }

  .feedback-link:hover {
    color: var(--color-primary, #0066cc);
    text-decoration: underline;
  }

  .login-btn {
    background: var(--color-primary, #0066cc);
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    text-decoration: none;
  }

  .login-btn:hover {
    background: var(--color-primary-dark, #0052a3);
  }

  .main-full {
    flex: 1;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    padding: 0.5rem;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-size: var(--text-2xl);
    color: var(--color-text-secondary, #666);
  }

  .app-footer {
    padding: 1.5rem 1rem;
    text-align: center;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    border-top: 1px solid var(--color-border);
    max-width: 1200px;
    margin: auto auto 0;
    width: 100%;
  }

  .app-footer a {
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .app-footer a:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .app-footer .separator {
    margin: 0 0.5rem;
  }

  .update-banner {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-primary, #0066cc);
    color: white;
    padding: 0.625rem 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    font-size: var(--text-md);
    text-align: center;
    border-radius: 999px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    z-index: 200;
    white-space: nowrap;
  }

  .update-btn {
    background: white;
    color: var(--color-primary, #0066cc);
    border: none;
    border-radius: 999px;
    padding: 0.25rem 0.75rem;
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    white-space: nowrap;
  }

  .update-btn:hover {
    background: rgba(255, 255, 255, 0.9);
  }

  @media (max-width: 1000px) {
    .update-banner {
      bottom: auto;
      top: 0;
      left: 0;
      transform: none;
      width: 100%;
      border-radius: 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
  }
</style>
