<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { positionFloating } from '$lib/utils/floating';
  import { normalizeHighlightTags } from '$lib/utils/highlightAliases';

  interface Props {
    /** The button the picker opened from; it follows it as the page scrolls. */
    anchor: HTMLElement;
    /** The highlight's tags as they stand. */
    tags: string[];
    /** Every tag the reader already uses, most-used first — the suggestions. */
    vocabulary: string[];
    onChange: (tags: string[]) => void;
    onClose: () => void;
  }

  let { anchor, tags, vocabulary, onChange, onClose }: Props = $props();

  // Where the anchor was at open, for when a re-render has since replaced it.
  // svelte-ignore state_referenced_locally
  let lastRect = anchor.getBoundingClientRect();

  let el = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let draft = $state('');

  const lower = (tag: string) => tag.toLowerCase();
  let current = $derived(new Set(tags.map(lower)));

  // The highlight's own tags first (so they can be unticked), then the rest of
  // the vocabulary, narrowed by whatever's typed.
  let options = $derived.by(() => {
    const needle = lower(draft.trim());
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tag of [...tags, ...vocabulary]) {
      const key = lower(tag);
      if (seen.has(key) || (needle && !key.includes(needle))) continue;
      seen.add(key);
      out.push(tag);
    }
    return out.slice(0, 12);
  });

  let canCreate = $derived(
    draft.trim().length > 0 &&
      !current.has(lower(draft.trim())) &&
      !options.some((tag) => lower(tag) === lower(draft.trim()))
  );

  function toggle(tag: string) {
    onChange(
      current.has(lower(tag))
        ? tags.filter((t) => lower(t) !== lower(tag))
        : normalizeHighlightTags([...tags, tag])
    );
  }

  function submit() {
    const tag = draft.trim();
    if (!tag) return;
    // Enter on a typed name that already exists ticks that tag in its
    // existing spelling rather than minting a near-duplicate.
    const existing = options.find((t) => lower(t) === lower(tag));
    if (!existing || !current.has(lower(existing))) toggle(existing ?? tag);
    draft = '';
  }

  // Escape closes from anywhere in the picker, not only the field.
  function onRootKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Backspace' && !e.repeat && !draft && tags.length > 0) {
      // Backspace in an empty field takes the last tag back off, as in a chip
      // input — but not on auto-repeat, so holding it to clear a typo can't run
      // on into the committed tags.
      onChange(tags.slice(0, -1));
    }
  }

  function reposition() {
    if (anchor.isConnected) lastRect = anchor.getBoundingClientRect();
    if (el) positionFloating(lastRect, el, { gap: 6, align: 'end' });
  }

  function onPointerDown(e: PointerEvent) {
    if (el && !el.contains(e.target as Node)) onClose();
  }

  onMount(async () => {
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', reposition);
    await tick();
    reposition();
    inputEl?.focus();
  });

  onDestroy(() => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', reposition);
    document.removeEventListener('scroll', reposition, true);
    window.visualViewport?.removeEventListener('resize', reposition);
    // Hand focus back to the button the picker opened from.
    if (el?.contains(document.activeElement) && anchor.isConnected) anchor.focus();
  });

  $effect(() => {
    void options.length;
    void tags.length;
    tick().then(reposition);
  });
</script>

<div
  bind:this={el}
  class="tag-picker"
  role="dialog"
  aria-label="Tag highlight"
  tabindex="-1"
  onkeydown={onRootKeydown}
  style="position: fixed; z-index: 200;"
>
  <div class="field">
    <Icon name="tag" size={14} />
    <input
      bind:this={inputEl}
      bind:value={draft}
      onkeydown={onKeydown}
      placeholder={tags.length ? 'Add another tag' : 'Add a tag'}
      aria-label="Tag name"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
    />
  </div>

  {#if options.length > 0 || canCreate}
    <ul class="options" role="listbox" aria-label="Tags" aria-multiselectable="true">
      {#each options as tag (lower(tag))}
        {@const on = current.has(lower(tag))}
        <li>
          <button
            class="option"
            class:on
            role="option"
            aria-selected={on}
            onclick={() => toggle(tag)}
          >
            <span class="check">
              {#if on}<Icon name="check" size={14} />{/if}
            </span>
            <span class="label">{tag}</span>
          </button>
        </li>
      {/each}
      {#if canCreate}
        <li>
          <button class="option create" onclick={submit}>
            <span class="check"><Icon name="plus" size={14} /></span>
            <span class="label">Create “{draft.trim()}”</span>
          </button>
        </li>
      {/if}
    </ul>
  {:else}
    <p class="hint">Type a name and press Enter.</p>
  {/if}
</div>

<style>
  .tag-picker {
    width: 16rem;
    max-width: calc(100vw - 16px);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 0.75rem;
    padding: 0.375rem;
    /* Floating tier — this genuinely sits above the page. */
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.15),
      0 1px 2px rgba(0, 0, 0, 0.08);
  }

  .field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.5rem;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }

  .field input {
    flex: 1;
    min-width: 0;
    height: 2.25rem;
    border: none;
    background: transparent;
    color: var(--color-text);
    /* 16px keeps iOS from zooming the page on focus. */
    font-size: 16px;
    outline: none;
  }

  .options {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
    max-height: 16rem;
    overflow-y: auto;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 2.25rem;
    padding: 0 0.5rem;
    border: none;
    border-radius: 0.5rem;
    background: none;
    color: var(--color-text);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .option:hover {
    background: var(--color-bg-secondary);
  }

  .option.on {
    color: var(--color-primary);
  }

  .option.create {
    color: var(--color-text-secondary);
  }

  .check {
    display: inline-flex;
    width: 14px;
    flex-shrink: 0;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    margin: 0.5rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
</style>
