<script lang="ts">
  import FeedPage from '$lib/components/feed/FeedPage.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { api } from '$lib/services/api';

  let restoring = $state(false);
  async function restore() {
    restoring = true;
    try {
      await api.restoreLinkblog();
      preferences.setLinkblogDisabled(false);
      location.reload();
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
    font-size: 1.35rem;
  }
  p {
    color: var(--text-secondary);
  }
  button {
    border: 0;
    border-radius: 0.4rem;
    padding: 0.65rem 1rem;
    background: #0066cc;
    color: white;
    cursor: pointer;
  }
</style>
