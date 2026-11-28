<script lang="ts">
  // Updates on a save the reader watches (stores/savedWatches.svelte.ts): new
  // mentions or citations since they last cleared it. ConnectionsBadge's shape
  // and its one blue, with the bell the Watch switch wears.
  import Icon from '$lib/components/Icon.svelte';
  import { updatesLabel } from '$lib/utils/watchEvents';

  let { count }: { count: number } = $props();

  let label = $derived(`${updatesLabel(count)} on a save you watch`);
</script>

<span class="watch-badge" title={label} aria-label={label}>
  <Icon name="bell" size={11} />
  {count} new
</span>

<style>
  .watch-badge {
    display: inline-flex;
    align-items: center;
    align-self: center;
    gap: 0.25rem;
    flex-shrink: 0;
    padding: 0 0.4375rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    line-height: 1.6;
    color: var(--color-primary);
    white-space: nowrap;
  }

  .watch-badge :global(.icon) {
    color: currentColor;
  }
</style>
