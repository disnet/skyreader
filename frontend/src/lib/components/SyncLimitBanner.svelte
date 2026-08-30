<script lang="ts">
  // What the last sync had to say, shown at the top of the app shell so it
  // outlives the screen that started the sync. See stores/syncNotices.
  import { syncNoticesStore } from '$lib/stores/syncNotices.svelte';
  import LimitNotice from '$lib/components/LimitNotice.svelte';
</script>

{#if !syncNoticesStore.isEmpty}
  <div class="sync-banner" role="status">
    <div class="sync-banner-body">
      {#if syncNoticesStore.feedNotices.length > 0}
        <LimitNotice kind="feeds">
          {#each syncNoticesStore.feedNotices as notice (notice.message)}
            <p>{notice.message}</p>
          {/each}
        </LimitNotice>
      {/if}

      {#if syncNoticesStore.mirrorNotices.length > 0}
        <LimitNotice kind="mirror">
          {#each syncNoticesStore.mirrorNotices as notice (notice.message)}
            <p>{notice.message}</p>
          {/each}
        </LimitNotice>
      {/if}

      <!-- Failures, not caps: stated plainly, with no upgrade attached. -->
      {#each syncNoticesStore.warnings as warning (warning)}
        <p class="sync-warning">{warning}</p>
      {/each}
    </div>

    <button class="dismiss-btn" onclick={() => syncNoticesStore.clear()}>Dismiss</button>
  </div>
{/if}

<style>
  /* Sits in the shell's flow above the frame, like the scope-upgrade banner.
     Flat by default — it pushes the app down rather than floating over it, so
     it earns no shadow. */
  .sync-banner {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .sync-banner-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    max-width: 42rem;
  }

  .sync-warning {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .dismiss-btn {
    flex-shrink: 0;
    padding: 0.25rem 0.5rem;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    background: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
  }

  .dismiss-btn:hover {
    color: var(--color-text);
    border-color: var(--color-text-secondary);
  }
</style>
