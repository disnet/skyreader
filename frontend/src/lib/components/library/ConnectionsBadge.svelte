<script lang="ts">
  // New Semble connections other people drew off a save
  // (stores/savedConnections.svelte.ts). The same quiet chip shape as
  // LibraryChip, with the one blue: it's the only mark on a card that says
  // something happened since you last looked.
  import Icon from '$lib/components/Icon.svelte';

  let { count }: { count: number } = $props();

  let label = $derived(`${count} new ${count === 1 ? 'connection' : 'connections'} on Semble`);
</script>

<span class="connections-badge" title={label} aria-label={label}>
  <Icon name="semble" size={11} />
  {count} new
</span>

<style>
  .connections-badge {
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

  .connections-badge :global(.icon) {
    color: currentColor;
  }
</style>
