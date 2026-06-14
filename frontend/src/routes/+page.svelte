<script lang="ts">
  // The landing route. A logged-out visitor gets the lightweight WelcomePage (which
  // imports nothing heavier than an Icon). The full FeedPage — and its dependency
  // graph (data layer, feed stores, modals) — is code-split and only fetched once
  // the user is authenticated, so the marketing page never downloads the app.
  import { browser } from '$app/environment';
  import type { Component } from 'svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import WelcomePage from '$lib/components/feed/WelcomePage.svelte';

  let FeedPage = $state<Component | null>(null);
  $effect(() => {
    if (browser && auth.isAuthenticated && !FeedPage) {
      import('$lib/components/feed/FeedPage.svelte').then((m) => {
        FeedPage = m.default;
      });
    }
  });
</script>

{#if auth.isAuthenticated}
  {#if FeedPage}
    <FeedPage />
  {/if}
{:else}
  <WelcomePage />
{/if}
