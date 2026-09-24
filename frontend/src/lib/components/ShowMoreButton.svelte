<script lang="ts">
  interface Props {
    /** How many rows are still hidden behind the current window. */
    remaining: number;
    /** Maximum number of rows the next click reveals. */
    batchSize: number;
    onclick: () => void;
  }
  let { remaining, batchSize, onclick }: Props = $props();
</script>

<!-- Progressive disclosure, not a call to action: it sits as the last row of
     the list it extends, in the list's own row rhythm. -->
{#if remaining > 0}
  <button class="show-more" type="button" {onclick}>
    Show {Math.min(remaining, batchSize)} more
  </button>
{/if}

<style>
  .show-more {
    display: block;
    width: 100%;
    padding: 0.625rem 0.75rem;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
    text-align: left;
    background: var(--color-bg);
    border: none;
    cursor: pointer;
  }

  .show-more:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.02));
  }

  .show-more:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -2px;
  }

  @media (max-width: 520px) {
    .show-more {
      min-height: 44px;
    }
  }
</style>
