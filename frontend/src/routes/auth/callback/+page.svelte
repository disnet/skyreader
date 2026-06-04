<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';
  import { api } from '$lib/services/api';
  import { registerPeriodicSync } from '$lib/services/backgroundRefresh';

  onMount(async () => {
    const returnUrl = $page.url.searchParams.get('returnUrl') || '/';

    // Returning to a public linkblog (served by Cloudflare Pages Functions, not
    // the SvelteKit router). Bounce straight back without booting the app: the
    // session cookie is already set, so the linkblog page's ?subscribe=1 resume
    // completes the follow. We cache the user for a later app visit but must NOT
    // call auth.setUser() — flipping isAuthenticated here would mount the app
    // sidebar + kick off appManager.initialize() for a frame, flashing full app
    // chrome before the redirect. replace() keeps this transient page out of
    // history (no callback URL to land on via Back).
    if (returnUrl.startsWith('/blogs/')) {
      try {
        const user = await api.getMe();
        auth.cacheUser(user);
      } catch {
        // Non-fatal: the session cookie still works; the marker just isn't primed.
      }
      window.location.replace(returnUrl);
      return;
    }

    try {
      // Session cookie was set by the OAuth callback redirect
      // Fetch user info to verify session and get user data
      const user = await api.getMe();

      // Store the user data for display caching
      auth.setUser(user);

      // Register for periodic background sync (Chromium only, fails gracefully on other browsers)
      registerPeriodicSync();

      // Navigate immediately — don't block on initialization.
      // +page.svelte's onMount will call appManager.initialize() which handles
      // hydration and background refresh. Previously, awaiting initialize() here
      // meant goto(returnUrl) could fire after the user had already navigated
      // away from the callback page (since the sidebar becomes visible once
      // auth is set), overriding their current location.
      goto(returnUrl);
    } catch (error) {
      console.error('Failed to complete login:', error);
      goto('/auth/error?error=Failed+to+complete+login');
    }
  });
</script>

<div class="callback-page">
  <p>Completing login...</p>
</div>

<style>
  .callback-page {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 50vh;
    color: var(--color-text-secondary);
  }
</style>
