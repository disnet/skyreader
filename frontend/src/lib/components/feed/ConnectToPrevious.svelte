<script lang="ts">
  // "This made me think of that", at the end of an article, with "that"
  // already offered: the last few articles read, as cards.
  //
  // Its own section above the discussion rather than a link inside it, where
  // it was easy to miss among other people's notes. One tap on a card to
  // connect it, one link to pick something else from the library instead.
  import Icon from '$lib/components/Icon.svelte';
  import ReadCards from './ReadCards.svelte';
  import type { ConnectSuggestion } from '$lib/stores/sembleConnection.svelte';

  let { suggestion }: { suggestion: ConnectSuggestion } = $props();

  const labelId = $props.id();
</script>

<section class="connect-previous" aria-label="Connect on Semble">
  <p class="connect-previous-lead" id={labelId}>
    <Icon name="semble" size={13} />
    Connect this to something you've read
  </p>
  <ReadCards items={suggestion.reads} labelledby={labelId} onpick={suggestion.onConnect} />
  <button
    type="button"
    class="connect-previous-other"
    onclick={(e) => {
      e.stopPropagation();
      suggestion.onPickOther();
    }}
  >
    Or pick something else from your library
  </button>
</section>

<style>
  .connect-previous {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .connect-previous-lead {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .connect-previous-other {
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .connect-previous-other:hover {
    color: var(--color-primary);
  }
</style>
