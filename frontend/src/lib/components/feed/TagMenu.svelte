<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import type { ItemTags } from '$lib/types';

  interface Props {
    itemKey: string;
    itemType: ItemTags['itemType'];
    anchorEl: HTMLElement | null;
    onClose: () => void;
  }

  let { itemKey, itemType, anchorEl, onClose }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let newTagInput = $state('');
  let showNewTagInput = $state(false);
  let inputRef = $state<HTMLInputElement | null>(null);

  let allTags = $derived(itemLabelsStore.allTags);
  let itemTags = $derived(itemLabelsStore.getTagsForItem(itemKey));

  // Show up to 9 existing tags
  let displayTags = $derived(allTags.slice(0, 9));

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    // If the new tag input is focused, don't handle number keys
    if (showNewTagInput && document.activeElement === inputRef) return;

    const num = parseInt(e.key);
    if (isNaN(num)) return;

    e.preventDefault();
    e.stopPropagation();

    if (num === 0) {
      showNewTagInput = true;
      requestAnimationFrame(() => inputRef?.focus());
      return;
    }

    const tagIndex = num - 1;
    if (tagIndex < displayTags.length) {
      itemLabelsStore.toggleTag(itemKey, itemType, displayTags[tagIndex]);
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }

  async function handleNewTagSubmit() {
    const tag = newTagInput.trim();
    if (!tag) return;
    await itemLabelsStore.addTag(itemKey, itemType, tag);
    newTagInput = '';
    showNewTagInput = false;
  }

  function handleNewTagKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleNewTagSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      showNewTagInput = false;
      newTagInput = '';
    }
    e.stopPropagation();
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('click', handleClickOutside, true);
    // Reposition on scroll so the menu stays anchored to the button
    document.addEventListener('scroll', positionMenu, true);
    window.addEventListener('resize', positionMenu);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('click', handleClickOutside, true);
    document.removeEventListener('scroll', positionMenu, true);
    window.removeEventListener('resize', positionMenu);
  });

  // Position the menu relative to anchor, adjusting for viewport edges
  function positionMenu() {
    if (!anchorEl || !menuEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    const gap = 4;

    // Vertical: prefer below, flip above if it would overflow bottom
    let top: number;
    if (rect.bottom + gap + menuRect.height > window.innerHeight) {
      top = Math.max(gap, rect.top - gap - menuRect.height);
    } else {
      top = rect.bottom + gap;
    }

    // Horizontal: prefer left-aligned with anchor, shift left if overflowing right
    let left = Math.min(rect.left, window.innerWidth - menuRect.width - gap);
    left = Math.max(gap, left);

    menuEl.style.top = `${top}px`;
    menuEl.style.left = `${left}px`;
  }

  $effect(() => {
    if (!anchorEl || !menuEl) return;
    // Re-position when tags or input state changes (menu height may change)
    void displayTags.length;
    void showNewTagInput;
    // Wait a tick for DOM to update before measuring
    requestAnimationFrame(positionMenu);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
  class="tag-menu"
  style="position: fixed; z-index: 200;"
  bind:this={menuEl}
  onclick={(e) => e.stopPropagation()}
>
  {#if displayTags.length > 0}
    <div class="tag-list">
      {#each displayTags as tag, i}
        {@const isActive = itemTags.includes(tag)}
        <button
          class="tag-item"
          class:active={isActive}
          onclick={() => itemLabelsStore.toggleTag(itemKey, itemType, tag)}
        >
          <span class="tag-number">{i + 1}</span>
          <span class="tag-name">{tag}</span>
          {#if isActive}
            <span class="tag-check"><Icon name="check" size={14} /></span>
          {/if}
        </button>
      {/each}
    </div>
    <div class="tag-divider"></div>
  {/if}

  {#if showNewTagInput}
    <div class="new-tag-row">
      <input
        type="text"
        bind:this={inputRef}
        bind:value={newTagInput}
        placeholder="Tag name..."
        onkeydown={handleNewTagKeydown}
        maxlength={64}
        class="new-tag-input"
      />
      <button class="new-tag-confirm" onclick={handleNewTagSubmit} disabled={!newTagInput.trim()}>
        <Icon name="check" size={14} />
      </button>
    </div>
  {:else}
    <button
      class="tag-item add-tag"
      onclick={() => {
        showNewTagInput = true;
        requestAnimationFrame(() => inputRef?.focus());
      }}
    >
      <span class="tag-number">0</span>
      <span class="tag-name">add new tag</span>
    </button>
  {/if}
</div>

<style>
  .tag-menu {
    min-width: 180px;
    max-width: 240px;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    padding: 0.25rem 0;
  }

  .tag-list {
    display: flex;
    flex-direction: column;
  }

  .tag-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--color-text);
    width: 100%;
    text-align: left;
  }

  .tag-item:hover {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .tag-item.active {
    color: var(--color-primary, #2563eb);
  }

  .tag-number {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 1.5px solid var(--color-border, #d1d5db);
    border-radius: 3px;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .tag-item.active .tag-number {
    border-color: var(--color-primary, #2563eb);
    color: var(--color-primary, #2563eb);
  }

  .tag-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-check {
    display: inline-flex;
    color: var(--color-primary, #2563eb);
    flex-shrink: 0;
  }

  .tag-divider {
    height: 1px;
    background: var(--color-border, #e5e7eb);
    margin: 0.25rem 0;
  }

  .add-tag {
    color: var(--color-text-secondary);
  }

  .add-tag .tag-number {
    border-style: dashed;
  }

  .new-tag-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
  }

  .new-tag-input {
    flex: 1;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 4px;
    font-size: var(--text-sm);
    background: var(--color-bg, #fff);
    color: var(--color-text);
    outline: none;
  }

  .new-tag-input:focus {
    border-color: var(--color-primary, #2563eb);
  }

  .new-tag-confirm {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 0.25rem;
    cursor: pointer;
    color: var(--color-primary, #2563eb);
  }

  .new-tag-confirm:disabled {
    opacity: 0.4;
    cursor: default;
  }

  @media (prefers-color-scheme: dark) {
    .tag-menu {
      background: var(--color-bg, #1a1a1a);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .tag-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .new-tag-input {
      background: var(--color-bg, #1a1a1a);
    }
  }
</style>
