<script lang="ts">
  // At the end of an article: ask for it to come back in a few weeks, so a
  // reread happens on purpose (stores/resurface.svelte.ts). One quiet line; once
  // set, it says when, and the same tap changes it.
  import Icon from '$lib/components/Icon.svelte';
  import { formatResurfaceDay } from '$lib/utils/resurface';

  interface Props {
    /** When it comes back, if the reader already asked. */
    at: number | null;
    onOpen: () => void;
  }

  let { at, onOpen }: Props = $props();
</script>

<section class="come-back" aria-label="Come back to this">
  <button
    type="button"
    class="come-back-btn"
    onclick={(e) => {
      e.stopPropagation();
      onOpen();
    }}
  >
    <Icon name="clock" size={13} />
    {#if at !== null}
      Comes back on {formatResurfaceDay(at, Date.now())}
      <span class="change">Change</span>
    {:else}
      Come back to this in a few weeks
    {/if}
  </button>
</section>

<style>
  .come-back {
    display: flex;
  }

  .come-back-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text);
    cursor: pointer;
  }

  .come-back-btn:hover,
  .come-back-btn:hover .change {
    color: var(--color-primary);
  }

  .come-back-btn:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .change {
    font-weight: normal;
    color: var(--color-text-secondary);
  }
</style>
