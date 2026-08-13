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
    <h1 class="deleted-linkblog-title">Your linkblog is deleted.</h1>
    <p class="deleted-linkblog-text">
      Restore it to share links again. Deleted posts won’t come back.
    </p>
    <button class="btn btn-primary" onclick={restore} disabled={restoring}>
      {restoring ? 'Restoring…' : 'Restore linkblog'}
    </button>
    {#if restoreError}
      <p class="deleted-linkblog-error" role="alert">{restoreError}</p>
    {/if}
  </section>
{:else}
  <FeedPage mode="linkblog" />
{/if}

<style>
  /* Classes, not bare element selectors: these leaked to every h1/p/button the
     route renders. The button is the shared .btn .btn-primary so it stays on the
     one interaction blue rather than re-deriving its own. */
  .deleted-linkblog {
    max-width: 36rem;
    margin: 5rem auto;
    padding: 2rem;
    text-align: center;
  }

  .deleted-linkblog-title {
    font-size: var(--text-2xl);
    font-weight: 600;
    line-height: var(--leading-tight);
    letter-spacing: -0.01em;
  }

  .deleted-linkblog-text {
    color: var(--color-text-secondary);
  }

  .deleted-linkblog-error {
    margin-top: 0.75rem;
    color: var(--color-error);
  }
</style>
