<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';

  // Hide the "View" caption in tight desktop rows (icons carry the meaning); show
  // it in the roomier mobile style sheet.
  let { showLabel = true }: { showLabel?: boolean } = $props();

  const options = [
    { value: 'scroll', label: 'Scroll', icon: 'align-justify' },
    { value: 'paged', label: 'Pages', icon: 'book-open' },
  ] as const;
</script>

<div class="view-toggle" role="group" aria-label="Reading layout">
  {#if showLabel}
    <span class="view-label">View</span>
  {/if}
  <div class="view-seg">
    {#each options as option}
      <button
        class="view-btn"
        class:active={preferences.readerViewMode === option.value}
        aria-pressed={preferences.readerViewMode === option.value}
        onclick={() => preferences.setReaderViewMode(option.value)}
        title={option.value === 'paged' ? 'Paged (Kindle-style)' : 'Continuous scroll'}
      >
        <Icon name={option.icon} size={16} />
        <span class="view-btn-label">{option.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .view-toggle {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .view-label {
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wide);
    padding-left: 0.375rem;
    white-space: nowrap;
  }

  .view-seg {
    display: flex;
    gap: 1px;
  }

  .view-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: none;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    border-radius: 6px;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .view-btn.active {
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text);
  }

  .view-btn:hover:not(.active) {
    color: var(--color-text);
  }

  .view-btn-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }

  @media (prefers-color-scheme: dark) {
    .view-btn.active {
      background: rgba(255, 255, 255, 0.15);
    }
  }
</style>
