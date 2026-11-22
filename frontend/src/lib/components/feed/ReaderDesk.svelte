<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { deskProgress, deskStore } from '$lib/stores/desk.svelte';
  import type { DeskEntry } from '$lib/utils/desk';

  // The Desk's list, shared by the desktop panel under the bar's Desk button and
  // the phone's sheet: the pieces on the Desk, the one open before this (when it
  // isn't on the Desk), and putting this piece on or off. Choosing a row switches
  // the reader to it, where it opens at its saved place.
  let {
    current,
    showShortcut = false,
    onswitch,
  }: {
    /** The open piece, as a Desk row. */
    current: DeskEntry;
    /** Desktop: name the `` ` `` key beside the piece open before this one. */
    showShortcut?: boolean;
    onswitch: (key: string) => void;
  } = $props();

  let onDesk = $derived(deskStore.has(current.key));
  let previous = $derived(deskStore.previous(current.key));
  let previousOffDesk = $derived(previous && !deskStore.has(previous.key) ? previous : null);

  function status(entry: DeskEntry): string {
    if (entry.key === current.key) return 'Reading now';
    const fraction = deskProgress(entry);
    const where = fraction === null ? 'Not started' : `${Math.round(fraction * 100)}%`;
    return entry.source ? `${entry.source} · ${where}` : where;
  }
</script>

<div class="desk">
  <div class="desk-head">
    <span class="desk-title">Desk</span>
    <span class="desk-sub">What you're reading now. Each opens where you left off.</span>
  </div>

  {#if deskStore.entries.length > 0}
    <ul class="desk-list">
      {#each deskStore.entries as entry (entry.key)}
        {@const isCurrent = entry.key === current.key}
        <li class="desk-row">
          <button
            type="button"
            class="desk-item"
            class:current={isCurrent}
            aria-current={isCurrent ? 'true' : undefined}
            disabled={isCurrent}
            onclick={() => onswitch(entry.key)}
          >
            <span class="desk-item-title">{entry.title}</span>
            <span class="desk-item-meta">{status(entry)}</span>
          </button>
          <button
            type="button"
            class="desk-remove"
            aria-label={`Take “${entry.title}” off the Desk`}
            title="Take off the Desk"
            onclick={() => deskStore.remove(entry.key)}
          >
            <Icon name="x" size={14} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if previousOffDesk}
    <div class="desk-section">Last open</div>
    <ul class="desk-list">
      <li class="desk-row">
        <button type="button" class="desk-item" onclick={() => onswitch(previousOffDesk.key)}>
          <span class="desk-item-title">{previousOffDesk.title}</span>
          <span class="desk-item-meta">{status(previousOffDesk)}</span>
        </button>
        {#if showShortcut}
          <kbd class="desk-kbd" title="Back to the last piece you had open">`</kbd>
        {/if}
      </li>
    </ul>
  {/if}

  <button
    type="button"
    class="desk-toggle"
    onclick={() => (onDesk ? deskStore.remove(current.key) : deskStore.add(current))}
  >
    <Icon name={onDesk ? 'minus' : 'plus'} size={14} />
    {onDesk ? 'Take this off the Desk' : 'Put this on the Desk'}
  </button>
</div>

<style>
  .desk {
    display: flex;
    flex-direction: column;
    font-size: var(--text-sm, 0.875rem);
  }

  .desk-head {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.25rem 0.75rem 0.5rem;
  }

  .desk-title {
    font-weight: var(--weight-semibold, 600);
    color: var(--color-text);
  }

  .desk-sub,
  .desk-section {
    color: var(--color-text-secondary);
    font-size: var(--text-xs, 0.75rem);
  }

  .desk-section {
    padding: 0.5rem 0.75rem 0.15rem;
  }

  .desk-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .desk-row {
    display: flex;
    align-items: center;
  }

  .desk-item {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.45rem 0.75rem;
    border: none;
    border-left: 2px solid transparent;
    background: none;
    font: inherit;
    text-align: left;
    color: var(--color-text);
    cursor: pointer;
  }

  .desk-item:hover:not(:disabled) {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .desk-item.current {
    border-left-color: var(--color-primary, #0066cc);
    cursor: default;
  }

  .desk-item.current .desk-item-title {
    font-weight: var(--weight-semibold, 600);
  }

  .desk-item-title {
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .desk-item-meta {
    color: var(--color-text-secondary);
    font-size: var(--text-xs, 0.75rem);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .desk-remove {
    flex: none;
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    margin-right: 0.25rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .desk-remove:hover {
    color: var(--color-text);
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .desk-kbd {
    flex: none;
    margin-right: 0.75rem;
    padding: 0 0.35rem;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs, 0.75rem);
    color: var(--color-text-secondary);
  }

  .desk-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.35rem;
    padding: 0.55rem 0.75rem;
    border: none;
    border-top: 1px solid var(--color-border);
    background: none;
    font: inherit;
    color: var(--color-primary, #0066cc);
    text-align: left;
    cursor: pointer;
  }

  .desk-toggle:hover {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .desk-item:focus-visible,
  .desk-remove:focus-visible,
  .desk-toggle:focus-visible {
    outline: 2px solid var(--color-primary, #0066cc);
    outline-offset: -2px;
  }

  @media (hover: none) and (pointer: coarse) {
    .desk {
      font-size: var(--text-base, 1rem);
    }

    .desk-item {
      padding-top: 0.65rem;
      padding-bottom: 0.65rem;
    }

    .desk-remove {
      width: 2.75rem;
      height: 2.75rem;
    }

    .desk-toggle {
      padding: 0.85rem 0.75rem;
    }
  }
</style>
