<script lang="ts">
  import FeedPage from '$lib/components/feed/FeedPage.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { api } from '$lib/services/api';

  let restoring = $state(false);
  let restoreError = $state<string | null>(null);
  async function restore() {
    restoring = true;
    restoreError = null;
    try {
      await api.restoreLinkblog();
      preferences.setLinkblogDisabled(false);
      location.reload();
    } catch {
      restoreError = 'Could not restore your linkblog. Try again.';
    } finally {
      restoring = false;
    }
  }
</script>

<svelte:head>
  <title>Linkblog - Skyreader</title>
</svelte:head>

{#if preferences.linkblogDisabled}
  <section class="deleted-linkblog">
    <h1>Your linkblog is deleted.</h1>
    <p>Restore it to share links again. Deleted posts won’t come back.</p>
    <button onclick={restore} disabled={restoring}
      >{restoring ? 'Restoring…' : 'Restore linkblog'}</button
    >
    {#if restoreError}
      <p class="error" role="alert">{restoreError}</p>
    {/if}
  </section>
{:else}
  <FeedPage mode="linkblog" />
{/if}

<style>
  .deleted-linkblog {
    max-width: 36rem;
    margin: 5rem auto;
    padding: 2rem;
    text-align: center;
  }
  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.01em;
  }
  p {
    color: var(--color-text-secondary);
  }
  button {
    border: 0;
    border-radius: 0.4rem;
    padding: 0.65rem 1rem;
    background: var(--color-primary);
    color: white;
    cursor: pointer;
  }
  .error {
    margin-top: 0.75rem;
    color: var(--color-error);
  }
</style>
