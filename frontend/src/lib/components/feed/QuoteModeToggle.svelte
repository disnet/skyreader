<script lang="ts">
  // How a quoted passage goes out on Bluesky: as a text shot (an image, with
  // the link in the text) or as text over the link card. Two named options
  // rather than a checkbox, so the "off" state says what it is. Radios under
  // the hood: arrow keys and screen readers work as a group for free.
  interface Props {
    /** True when quotes go out as images. */
    textShots: boolean;
    onchange: (textShots: boolean) => void;
    /** "Quote as" for one passage, "Quotes as" for a draft with several. */
    label?: string;
  }

  let { textShots, onchange, label = 'Quote as' }: Props = $props();

  const name = `quote-mode-${Math.random().toString(36).slice(2, 8)}`;
</script>

<div class="quote-mode" role="radiogroup" aria-label={label}>
  <span class="label" aria-hidden="true">{label}</span>
  <div class="segments">
    <label class="segment" class:selected={textShots}>
      <input type="radio" {name} checked={textShots} onchange={() => onchange(true)} />
      Image
    </label>
    <label class="segment" class:selected={!textShots}>
      <input type="radio" {name} checked={!textShots} onchange={() => onchange(false)} />
      Text
    </label>
  </div>
</div>

<style>
  .quote-mode {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .segments {
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
  }

  .segment {
    position: relative;
    padding: 0.1875rem 0.75rem;
    border-radius: 999px;
    color: var(--color-text-secondary);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .segment:hover:not(.selected) {
    color: var(--color-text);
  }

  /* Neutral, not blue: Post stays the one blue control nearby. */
  .segment.selected {
    background: color-mix(in srgb, var(--color-text) 9%, var(--color-bg));
    color: var(--color-text);
  }

  .segment input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .segment:has(input:focus-visible) {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  @media (prefers-reduced-motion: reduce) {
    .segment {
      transition: none;
    }
  }
</style>
