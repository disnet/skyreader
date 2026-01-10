<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';

  onMount(() => {
    const sessionId = $page.url.searchParams.get('sessionId');
    const returnUrl = $page.url.searchParams.get('returnUrl') || '/';

    if (!sessionId) {
      goto('/auth/error?error=Missing+session');
      return;
    }

    // Fetch user info from the session
    // For now, we'll parse it from the URL or make an API call
    // In a real app, you'd want to fetch the session details
    const stored = localStorage.getItem('at-rss-auth');
    if (stored) {
      // Already have a session, just redirect
      goto(returnUrl);
      return;
    }

    // Store the session ID and redirect
    // The actual user info should come from the backend
    // For now, we'll store a placeholder and the layout will show the user
    const user = {
      did: '',
      handle: 'loading...',
      pdsUrl: ''
    };

    auth.setSession(user, sessionId);
    goto(returnUrl);
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
