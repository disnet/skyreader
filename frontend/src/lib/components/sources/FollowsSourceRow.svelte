<script lang="ts">
  // "People you follow on Bluesky" as a source: the links they share, gathered
  // from your Following timeline into the follows channel. The permission ask
  // lives here, beside every other way of adding a source. Shaped like a
  // SourceRow, with a text action instead of icon buttons, because the action
  // needs words ("Allow" asks for the permission). See docs/plans/FOLLOWS_LINKS_PLAN.md.
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { followLinksStore } from '$lib/stores/followLinks.svelte';
  import { FOLLOWING_PATH, grantFollowsAccess } from '$lib/utils/followsChannel';

  onMount(() => void followLinksStore.load());

  let granted = $derived(followLinksStore.loaded && !followLinksStore.scopeRequired);
  let saving = $state(false);

  async function toggleEverything(on: boolean) {
    saving = true;
    try {
      await followLinksStore.setInEverything(on);
    } catch {
      // The store puts the old value back; the checkbox follows it.
    } finally {
      saving = false;
    }
  }
</script>

<div class="follows-row" id="follows">
  <div class="follows-icon"><Icon name="share-2" size={16} /></div>

  <div class="follows-info">
    <span class="follows-title">Links from people you follow</span>
    {#if granted}
      <span class="follows-meta">
        What they share on Bluesky, gathered into your From your follows channel.
      </span>
      <label class="follows-toggle">
        <input
          type="checkbox"
          checked={followLinksStore.inEverything === true}
          disabled={saving}
          onchange={(e) => toggleEverything(e.currentTarget.checked)}
        />
        Show them in Everything too
      </label>
    {:else}
      <span class="follows-meta">
        Skyreader reads your Bluesky Following timeline for the links in it, keeps them for a week,
        and never posts anything.
      </span>
    {/if}
  </div>

  {#if granted}
    <a class="follows-action" href={FOLLOWING_PATH}>Open</a>
  {:else if followLinksStore.loaded}
    <button
      type="button"
      class="follows-action primary"
      disabled={auth.grantingPermissions}
      onclick={() => grantFollowsAccess()}
    >
      Allow
    </button>
  {/if}
</div>

<style>
  .follows-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    background: var(--color-bg);
    scroll-margin-top: 4rem;
  }

  .follows-icon {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .follows-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .follows-title {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }

  .follows-meta {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
  }

  .follows-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.25rem;
    font-size: var(--text-sm);
    color: var(--color-text);
    cursor: pointer;
  }

  .follows-toggle input {
    margin: 0;
    cursor: pointer;
  }

  .follows-action {
    flex-shrink: 0;
    padding: 0.3125rem 0.75rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 6px);
    text-decoration: none;
    cursor: pointer;
  }

  .follows-action:hover {
    border-color: var(--color-primary);
  }

  .follows-action.primary {
    color: #fff;
    background: var(--color-primary);
    border-color: var(--color-primary);
  }

  .follows-action.primary:hover {
    background: var(--color-primary-dark);
  }

  .follows-action:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
</style>
