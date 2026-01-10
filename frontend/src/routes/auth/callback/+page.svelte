<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';
  import { api } from '$lib/services/api';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';

  onMount(async () => {
    const sessionId = $page.url.searchParams.get('sessionId');
    const returnUrl = $page.url.searchParams.get('returnUrl') || '/';

    if (!sessionId) {
      goto('/auth/error?error=Missing+session');
      return;
    }

    // Check if we already have a valid session
    const stored = localStorage.getItem('at-rss-auth');
    if (stored) {
      goto(returnUrl);
      return;
    }

    try {
      // Set the session ID so the API can make authenticated requests
      api.setSession(sessionId);

      // Fetch the user info from the backend
      const user = await api.getMe();

      // Store the session with the real user data
      auth.setSession(user, sessionId);

      // Sync subscriptions from PDS
      await subscriptionsStore.syncFromPds();

      goto(returnUrl);
    } catch (error) {
      console.error('Failed to fetch user info:', error);
      goto('/auth/error?error=Failed+to+fetch+user+info');
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
