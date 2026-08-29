<script lang="ts">
  import Icon from './Icon.svelte';

  interface Props {
    /** How many rows are still hidden behind the current window. */
    remaining: number;
    /** Maximum number of rows the next click reveals. */
    batchSize: number;
    onclick: () => void;
  }
  let { remaining, batchSize, onclick }: Props = $props();
</script>

<!-- Progressive disclosure, not a call to action: quiet text button, same
     weight as the "N hidden accounts" toggle it sits near. -->
{#if remaining > 0}
  <button class="show-more" type="button" {onclick}>
    <Icon name="chevron-down" size={14} />
    Show {Math.min(remaining, batchSize)} more
  </button>
{/if}

<style>
  .show-more {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.5rem;
    padding: 0.375rem 0;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: color 0.15s;
  }

  .show-more:hover {
    color: var(--color-text);
  }

  @media (max-width: 520px) {
    .show-more {
      min-height: 44px;
    }
  }
</style>
