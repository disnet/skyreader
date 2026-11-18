<script lang="ts">
  import { tooltip } from '$lib/actions/tooltip';
  import { SELECTION_UNITS, type SelectionUnit } from '$lib/utils/selectionUnits';

  /**
   * Words · Sentence · Paragraph: grows the live selection to that unit around
   * what the reader picked (or back down to it). Shared by the selection
   * toolbar and the touch selection bar.
   *
   * A press here must not take the selection away. A mouse press on a button
   * would collapse it, and a tap on iOS or Android dismisses it outright (which
   * the touch path reads as "highlight this"), so both are cancelled at the
   * press and the step is taken on release instead.
   */
  interface Props {
    unit: SelectionUnit;
    onUnit: (unit: SelectionUnit) => void;
    /** Show the keyboard hint in each tooltip (pointer devices only). */
    keyHints?: boolean;
  }

  let { unit, onUnit, keyHints = false }: Props = $props();

  const LABELS: Record<SelectionUnit, string> = {
    word: 'Words',
    sentence: 'Sentence',
    paragraph: 'Paragraph',
  };

  function hint(u: SelectionUnit): string | null {
    if (!keyHints) return null;
    const here = SELECTION_UNITS.indexOf(unit);
    const there = SELECTION_UNITS.indexOf(u);
    if (there === here + 1) return 'Expand (E)';
    if (there === here - 1) return 'Shrink (Shift E)';
    return null;
  }

  function onTouchEnd(e: TouchEvent, u: SelectionUnit) {
    const touch = e.changedTouches[0];
    const target = e.currentTarget as HTMLElement;
    const hit = touch && document.elementFromPoint(touch.clientX, touch.clientY);
    // A finger that slid off the button before lifting changed its mind.
    if (hit && target.contains(hit)) onUnit(u);
  }
</script>

<div class="selection-steps" role="group" aria-label="Select">
  {#each SELECTION_UNITS as u (u)}
    <button
      type="button"
      class="step"
      class:active={u === unit}
      aria-pressed={u === unit}
      use:tooltip={hint(u) ?? ''}
      onmousedown={(e) => e.preventDefault()}
      ontouchstart={(e) => e.preventDefault()}
      ontouchend={(e) => onTouchEnd(e, u)}
      onclick={() => onUnit(u)}
    >
      {LABELS[u]}
    </button>
  {/each}
</div>

<style>
  .selection-steps {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .step {
    border: none;
    background: none;
    padding: 0.3125rem 0.625rem;
    border-radius: 999px;
    font: inherit;
    font-size: var(--text-sm);
    line-height: 1.2;
    color: var(--color-text-secondary);
    cursor: pointer;
    white-space: nowrap;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    transition:
      background-color 120ms ease,
      color 120ms ease;
  }

  .step:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .step.active {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    color: var(--color-primary);
    font-weight: 600;
  }

  .step:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--color-primary);
  }

  @media (pointer: coarse) {
    .step {
      padding: 0.5rem 0.75rem;
      font-size: var(--text-base, 1rem);
    }
  }
</style>
