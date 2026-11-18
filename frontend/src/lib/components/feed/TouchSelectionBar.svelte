<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import SelectionSteps from '$lib/components/feed/SelectionSteps.svelte';
  import type { SelectionUnit } from '$lib/utils/selectionUnits';

  /**
   * The touch counterpart of the selection toolbar, docked above the reader's
   * bottom bar while a selection is live in the article. The system's own menu
   * (Copy, Look Up…) keeps the space beside the selection; this keeps the
   * thumb's.
   *
   * Letting go of a selection still highlights it, as before; Highlight here
   * just says so out loud.
   */
  interface Props {
    unit: SelectionUnit;
    onUnit: (unit: SelectionUnit) => void;
    onHighlight: () => void;
    /** Called as a press lands anywhere on the bar, before it can dismiss the selection. */
    onPress: () => void;
  }

  let { unit, onUnit, onHighlight, onPress }: Props = $props();

  function onHighlightTouchEnd(e: TouchEvent) {
    const touch = e.changedTouches[0];
    const target = e.currentTarget as HTMLElement;
    const hit = touch && document.elementFromPoint(touch.clientX, touch.clientY);
    if (hit && target.contains(hit)) onHighlight();
  }
</script>

<div
  class="touch-selection-bar"
  role="toolbar"
  aria-label="Selection"
  ontouchstartcapture={onPress}
  onpointerdowncapture={onPress}
>
  <SelectionSteps {unit} {onUnit} />
  <button
    type="button"
    class="highlight"
    aria-label="Highlight selection"
    onmousedown={(e) => e.preventDefault()}
    ontouchstart={(e) => e.preventDefault()}
    ontouchend={onHighlightTouchEnd}
    onclick={onHighlight}
  >
    <span class="icon"><Icon name="highlighter" size={20} /></span>
    <span class="label">Highlight</span>
  </button>
</div>

<style>
  .touch-selection-bar {
    position: fixed;
    left: 50%;
    bottom: calc(var(--bottom-bar-height) + var(--safe-area-bottom) + 0.75rem);
    transform: translateX(-50%);
    width: max-content;
    max-width: calc(100vw - 1rem);
    box-sizing: border-box;
    z-index: 210;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 0.875rem;
    /* Floating tier: it sits over the text. */
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.15),
      0 1px 2px rgba(0, 0, 0, 0.08);
    -webkit-user-select: none;
    user-select: none;
    animation: bar-in 160ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .highlight {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-left: 0.25rem;
    padding: 0.5rem 0.875rem;
    border: none;
    border-radius: 0.625rem;
    background: var(--color-primary);
    color: #fff;
    font: inherit;
    font-size: var(--text-base, 1rem);
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    cursor: pointer;
    -webkit-touch-callout: none;
  }

  .touch-selection-bar :global(.step) {
    padding: 0.5rem 0.5rem;
    font-size: 0.9375rem;
  }

  .icon {
    display: none;
  }

  /* The narrowest phones: Highlight as its glyph, so all four still fit. */
  @media (max-width: 359px) {
    .touch-selection-bar :global(.step) {
      padding: 0.5rem 0.375rem;
    }

    .highlight {
      padding: 0.5rem 0.625rem;
    }

    .icon {
      display: inline-flex;
    }

    .label {
      display: none;
    }
  }

  .highlight:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 2px var(--color-bg),
      0 0 0 4px var(--color-primary);
  }

  /* The dark scheme's lighter blue needs dark ink to read. */
  @media (prefers-color-scheme: dark) {
    .highlight {
      color: var(--color-bg);
    }
  }

  @keyframes bar-in {
    from {
      opacity: 0;
      transform: translate(-50%, 0.5rem);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .touch-selection-bar {
      animation: none;
    }
  }
</style>
