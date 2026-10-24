<script lang="ts">
  // "This made me think of that", at the end of an article, with "that"
  // already named: the article read just before this one.
  //
  // Its own section above the discussion rather than a link inside it, where
  // it was easy to miss among other people's notes. One row to accept the
  // guess, one link to pick something else from the library instead.
  import Icon from '$lib/components/Icon.svelte';
  import type { ConnectSuggestion } from '$lib/stores/sembleConnection.svelte';

  let { suggestion }: { suggestion: ConnectSuggestion } = $props();
</script>

<section class="connect-previous" aria-label="Connect on Semble">
  <p class="connect-previous-lead">
    <Icon name="semble" size={13} />
    Connect this to what you just read
  </p>
  <button
    type="button"
    class="connect-previous-pick"
    onclick={(e) => {
      e.stopPropagation();
      suggestion.onConnect();
    }}
  >
    <span class="connect-previous-text">
      <span class="connect-previous-title">{suggestion.label}</span>
      <span class="connect-previous-host">{suggestion.host}</span>
    </span>
    <span class="connect-previous-action">
      Connect
      <Icon name="arrow-right" size={13} />
    </span>
  </button>
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

  .connect-previous-pick {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    font: inherit;
    text-align: left;
    color: var(--color-text);
    cursor: pointer;
    transition: border-color 0.15s ease;
  }

  .connect-previous-pick:hover {
    border-color: var(--color-primary);
  }

  .connect-previous-pick:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .connect-previous-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1;
    min-width: 0;
  }

  .connect-previous-title,
  .connect-previous-host {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .connect-previous-title {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
  }

  .connect-previous-host {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .connect-previous-action {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-primary);
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

  @media (prefers-reduced-motion: reduce) {
    .connect-previous-pick {
      transition: none;
    }
  }
</style>
