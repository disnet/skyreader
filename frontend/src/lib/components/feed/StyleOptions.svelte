<script lang="ts" module>
  import type { ArticleFont } from '$lib/stores/preferences.svelte';

  // Each option previews in its own reader typeface, with a plain-language hint
  // so the two serifs (Charter vs. Literata) don't read as the same choice.
  export const FONT_OPTIONS: { value: ArticleFont; name: string; hint: string; family: string }[] =
    [
      { value: 'sans-serif', name: 'Sans', hint: 'System', family: 'var(--font-sans-serif)' },
      { value: 'serif', name: 'Serif', hint: 'Charter', family: 'var(--font-serif)' },
      { value: 'literata', name: 'Literata', hint: 'Book', family: 'var(--font-literata)' },
      { value: 'mono', name: 'Mono', hint: 'Code', family: 'var(--font-mono)' },
    ];
</script>

<script lang="ts">
  // The reader's type settings as rows: the four fonts, each set in its own face
  // with a check on the one in use, then a size stepper. The desktop Style menu
  // (StyleMenu) floats these under its button; the phone's sheet lays them out
  // in place. A pick applies at once and leaves the rows up, so the reader can
  // watch the page change and keep adjusting.
  import Icon from '$lib/components/Icon.svelte';
  import {
    preferences,
    ARTICLE_FONT_SIZE_MIN,
    ARTICLE_FONT_SIZE_MAX,
  } from '$lib/stores/preferences.svelte';

  interface Props {
    /** Card rows (the floating menu) or bordered rows on a sheet. */
    variant?: 'menu' | 'sheet';
  }

  let { variant = 'menu' }: Props = $props();

  const uid = $props.id();
  let fontsEl = $state<HTMLDivElement | null>(null);

  // A radio group: arrows move the choice (and focus) through the fonts.
  // Exported so the floating menu can drive it from its own key listener, which
  // runs ahead of the reader's shortcuts and keeps them from seeing the arrows.
  export function onFontKeydown(e: KeyboardEvent) {
    if (!fontsEl?.contains(e.target as Node)) return;
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const at = FONT_OPTIONS.findIndex((o) => o.value === preferences.articleFont);
    const next = (Math.max(at, 0) + step + FONT_OPTIONS.length) % FONT_OPTIONS.length;
    preferences.setArticleFont(FONT_OPTIONS[next].value);
    fontsEl.querySelectorAll<HTMLButtonElement>('.style-font')[next]?.focus();
  }
</script>

<div class="style-options" class:sheet={variant === 'sheet'}>
  <div class="style-heading" id="{uid}-font">Font</div>
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="style-fonts"
    role="radiogroup"
    aria-labelledby="{uid}-font"
    bind:this={fontsEl}
    onkeydown={onFontKeydown}
  >
    {#each FONT_OPTIONS as option (option.value)}
      {@const checked = preferences.articleFont === option.value}
      <button
        class="style-font"
        class:checked
        role="radio"
        aria-checked={checked}
        tabindex={checked ? 0 : -1}
        onclick={() => preferences.setArticleFont(option.value)}
      >
        <span class="style-specimen" style:font-family={option.family} aria-hidden="true">Ag</span>
        <span class="style-name" style:font-family={option.family}>{option.name}</span>
        <span class="style-hint">{option.hint}</span>
        <span class="style-check" aria-hidden="true">
          {#if checked}<Icon name="check" size={16} />{/if}
        </span>
      </button>
    {/each}
  </div>

  <div class="style-size">
    <span class="style-size-label" id="{uid}-size">Size</span>
    <div class="style-stepper" role="group" aria-labelledby="{uid}-size">
      <button
        class="style-step"
        onclick={() => preferences.decreaseFontSize()}
        disabled={preferences.articleFontSize <= ARTICLE_FONT_SIZE_MIN}
        aria-label="Smaller text"
        title="Smaller text"
      >
        <Icon name="minus" size={16} />
      </button>
      <span class="style-size-value" aria-live="polite">{preferences.articleFontSize}</span>
      <button
        class="style-step"
        onclick={() => preferences.increaseFontSize()}
        disabled={preferences.articleFontSize >= ARTICLE_FONT_SIZE_MAX}
        aria-label="Larger text"
        title="Larger text"
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  </div>
</div>

<style>
  .style-options {
    display: flex;
    flex-direction: column;
  }

  .style-heading {
    padding: 0.375rem 0.625rem 0.25rem;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .style-fonts {
    display: flex;
    flex-direction: column;
  }

  /* Rows read like the Share menu's: an icon-width slot (here the specimen),
     the name, a quiet hint, and the check at the end. */
  .style-font {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.4375rem 0.625rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    line-height: 1.25rem;
    text-align: left;
    cursor: pointer;
  }

  .style-font:hover,
  .style-font:focus-visible {
    background: var(--color-bg-secondary);
    outline: none;
  }

  .style-specimen {
    display: flex;
    justify-content: center;
    width: 18px;
    flex-shrink: 0;
    font-size: 1.125rem;
    line-height: 1.25rem;
    color: var(--color-text-secondary);
    /* Pin every family to the system sans x-height, so Literata doesn't tower. */
    font-size-adjust: 0.52;
  }

  .style-font.checked .style-specimen {
    color: var(--color-primary);
  }

  .style-name {
    font-size-adjust: 0.52;
  }

  .style-hint {
    flex: 1;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  .style-check {
    display: flex;
    width: 16px;
    flex-shrink: 0;
    color: var(--color-primary);
  }

  .style-size {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 0.25rem;
    padding: 0.375rem 0.25rem 0.125rem 0.625rem;
    border-top: 1px solid var(--color-border);
  }

  .style-size-label {
    font-size: var(--text-md);
  }

  .style-stepper {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .style-step {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .style-step:hover:not(:disabled),
  .style-step:focus-visible {
    background: var(--color-bg-secondary);
    color: var(--color-text);
    outline: none;
  }

  .style-step:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .style-size-value {
    min-width: 1.75rem;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* On the phone's sheet: the same rows, in the bordered list the sheet's
     Actions use, sized for a thumb. */
  .style-options.sheet .style-heading {
    display: none;
  }

  .style-options.sheet .style-fonts {
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  .style-options.sheet .style-font {
    min-height: 48px;
    padding: 0.625rem 1rem;
    border-radius: 0;
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-lg);
  }

  .style-options.sheet .style-font:last-child {
    border-bottom: none;
  }

  .style-options.sheet .style-size {
    margin-top: 0.625rem;
    padding: 0.25rem 0.25rem 0.25rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: 10px;
  }

  .style-options.sheet .style-size-label,
  .style-options.sheet .style-size-value {
    font-size: var(--text-lg);
  }

  .style-options.sheet .style-step {
    width: 44px;
    height: 44px;
  }

  @media (hover: none) and (pointer: coarse) {
    .style-font {
      min-height: 48px;
    }
    .style-step {
      width: 44px;
      height: 44px;
    }
  }
</style>
