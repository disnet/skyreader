<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  /**
   * The one visible sign that the reader is re-bounding an existing highlight.
   * Entering Adjust re-selects the highlight's text and then gets out of the way
   * so the native selection handles are usable — without this strip that mode
   * would be invisible, and the next selection anywhere in the article would
   * silently move the old highlight onto it.
   */
  let { onCancel }: { onCancel: () => void } = $props();

  // Pointerdown, not click: on touch, the press that dismisses a selection
  // collapses it first, and a collapsed selection is what commits the
  // adjustment. Cancelling on the way down beats that race. `click` stays
  // wired for keyboard activation — cancelling twice is a no-op.
  function cancelOnPointer(e: PointerEvent) {
    e.preventDefault();
    onCancel();
  }
</script>

<div class="adjust-bar" role="status">
  <span class="adjust-hint">Adjusting a highlight — drag its ends, then confirm.</span>
  <button
    class="adjust-cancel"
    type="button"
    onpointerdown={cancelOnPointer}
    onclick={() => onCancel()}
  >
    <Icon name="x" size={14} />
    Cancel
  </button>
</div>

<style>
  .adjust-bar {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 0.75rem);
    left: 50%;
    transform: translateX(-50%);
    z-index: 199;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    max-width: min(92vw, 30rem);
    padding: 0.4375rem 0.5rem 0.4375rem 0.875rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    /* Floating tier — it genuinely sits above the page. */
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.12),
      0 1px 2px rgba(0, 0, 0, 0.06);
  }

  .adjust-hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .adjust-cancel {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .adjust-cancel:hover {
    background: var(--color-bg-secondary);
  }

  .adjust-cancel:focus-visible {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.18);
  }

  @media (pointer: coarse) {
    .adjust-cancel {
      min-height: 2.25rem;
      padding: 0.25rem 0.875rem;
    }
  }

  @media (prefers-color-scheme: dark) {
    .adjust-bar {
      box-shadow:
        0 4px 16px rgba(0, 0, 0, 0.5),
        0 1px 2px rgba(0, 0, 0, 0.4);
    }
  }
</style>
