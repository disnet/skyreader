<script lang="ts">
  import Icon from './Icon.svelte';
  import NumberIcon from './NumberIcon.svelte';
  import { tagsStore } from '$lib/stores/tags.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';

  interface Props {
    tags: string[];
    onAdd: (tag: string) => void;
    onRemove: (tag: string) => void;
    open?: boolean;
    listenForToggle?: boolean;
  }

  let { tags, onAdd, onRemove, open = $bindable(false), listenForToggle = false }: Props = $props();

  let showMenu = $state(false);
  let isCreatingTag = $state(false);
  let newTagValue = $state('');
  let newTagInputRef = $state<HTMLInputElement | null>(null);

  // Sync external open prop to internal showMenu
  $effect(() => {
    if (open && !showMenu) {
      showMenu = true;
      isCreatingTag = false;
      newTagValue = '';
      keyboardStore.suppress();
    }
  });

  // Keep open prop in sync with showMenu
  $effect(() => {
    open = showMenu;
  });

  function handleButtonClick(e: MouseEvent) {
    e.stopPropagation();
    if (showMenu) {
      closeMenu();
    } else {
      showMenu = true;
      isCreatingTag = false;
      newTagValue = '';
      keyboardStore.suppress();
    }
  }

  function handleTagToggle(e: MouseEvent, tag: string) {
    e.stopPropagation();
    if (tags.includes(tag)) {
      onRemove(tag);
    } else {
      onAdd(tag);
    }
  }

  function handleStartCreate(e?: MouseEvent) {
    e?.stopPropagation();
    isCreatingTag = true;
    requestAnimationFrame(() => newTagInputRef?.focus());
  }

  function handleNewTagKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const value = newTagValue.trim();
      if (value) {
        onAdd(value);
        newTagValue = '';
        isCreatingTag = false;
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      isCreatingTag = false;
      newTagValue = '';
    }
  }

  function closeMenu() {
    showMenu = false;
    isCreatingTag = false;
    newTagValue = '';
    keyboardStore.unsuppress();
  }

  function handleClose(e?: MouseEvent) {
    closeMenu();
  }

  function handleMenuKeydown(e: KeyboardEvent) {
    if (!showMenu) return;
    // Don't intercept when typing in the new tag input
    if (isCreatingTag) return;

    const key = e.key;

    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      return;
    }

    if (key === '0') {
      e.preventDefault();
      e.stopPropagation();
      handleStartCreate();
      return;
    }

    const num = parseInt(key);
    if (num >= 1 && num <= 9) {
      const tagIndex = num - 1;
      if (tagIndex < tagsStore.allTags.length) {
        e.preventDefault();
        e.stopPropagation();
        const tag = tagsStore.allTags[tagIndex];
        if (tags.includes(tag)) {
          onRemove(tag);
        } else {
          onAdd(tag);
        }
      }
    }
  }

  // Listen for keyboard shortcuts while menu is open
  $effect(() => {
    if (showMenu) {
      const handler = (e: KeyboardEvent) => handleMenuKeydown(e);
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }
  });

  // Listen for external toggle event (from 't' keyboard shortcut)
  // Only the expanded card's TagMenuButton should respond
  $effect(() => {
    if (!listenForToggle) return;
    const handler = () => {
      if (showMenu) {
        closeMenu();
      } else {
        showMenu = true;
        isCreatingTag = false;
        newTagValue = '';
        keyboardStore.suppress();
      }
    };
    document.addEventListener('toggle-tag-menu', handler);
    return () => document.removeEventListener('toggle-tag-menu', handler);
  });
</script>

<div class="tag-menu-anchor">
  <button class="action-btn" class:has-tags={tags.length > 0} onclick={handleButtonClick}>
    <span class="action-icon"><Icon name="tag" size={16} /></span><span class="action-label"
      >Tag{tags.length > 0 ? ` (${tags.length})` : ''}</span
    >
  </button>
  {#if showMenu}
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="tag-menu-backdrop" onclick={handleClose}></div>
    <div class="tag-menu" onclick={(e) => e.stopPropagation()}>
      {#each tagsStore.allTags as tag, i}
        <button
          class="tag-menu-item"
          class:active={tags.includes(tag)}
          onclick={(e) => handleTagToggle(e, tag)}
        >
          <span class="tag-menu-number"><NumberIcon number={i + 1} size={16} /></span>
          <span class="tag-menu-label">{tag}</span>
          {#if tags.includes(tag)}
            <span class="tag-menu-check"><Icon name="x" size={10} /></span>
          {/if}
        </button>
      {/each}
      {#if isCreatingTag}
        <div class="tag-menu-item tag-menu-create-input">
          <span class="tag-menu-number"><NumberIcon number={0} size={16} /></span>
          <input
            bind:this={newTagInputRef}
            type="text"
            bind:value={newTagValue}
            class="tag-new-input"
            placeholder="Tag name..."
            maxlength={64}
            onkeydown={handleNewTagKeydown}
          />
        </div>
      {:else}
        <button class="tag-menu-item tag-menu-create" onclick={handleStartCreate}>
          <span class="tag-menu-number"><NumberIcon number={0} size={16} /></span>
          <span class="tag-menu-label">create new tag</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tag-menu-anchor {
    position: relative;
  }

  .action-btn {
    display: flex;
    align-items: center;
    white-space: nowrap;
    background: none;
    border: none;
    font-size: 1rem;
    color: var(--color-text-secondary);
    padding: 0;
    cursor: pointer;
    text-decoration: none;
  }

  .action-btn:hover {
    color: var(--color-primary, #0066cc);
  }

  .action-btn.has-tags {
    color: var(--color-primary, #0066cc);
  }

  .action-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .action-label {
    margin-left: 0.25rem;
    font-size: 0.875rem;
  }

  .tag-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
  }

  .tag-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    min-width: 180px;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 110;
    overflow: hidden;
    padding: 0.25rem 0;
  }

  .tag-menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
    background: none;
    border: none;
    font-size: 0.8125rem;
    color: var(--color-text);
    cursor: pointer;
    text-align: left;
  }

  .tag-menu-item:hover {
    background: var(--color-bg-secondary, #f3f4f6);
  }

  .tag-menu-item.active {
    color: var(--color-primary, #0066cc);
    font-weight: 500;
  }

  .tag-menu-number {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .tag-menu-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag-menu-check {
    display: inline-flex;
    align-items: center;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .tag-menu-create {
    border-top: 1px solid var(--color-border, #e5e7eb);
    color: var(--color-text-secondary);
  }

  .tag-menu-create-input {
    border-top: 1px solid var(--color-border, #e5e7eb);
  }

  .tag-new-input {
    flex: 1;
    padding: 0.125rem 0.375rem;
    border: 1px solid var(--color-primary, #2563eb);
    border-radius: 4px;
    font-size: 0.8125rem;
    background: var(--color-bg, #fff);
    color: var(--color-text);
    outline: none;
  }

  .tag-new-input::placeholder {
    color: var(--color-text-secondary, #999);
  }

  @media (prefers-color-scheme: dark) {
    .tag-menu {
      background: var(--color-bg, #1a1a1a);
    }

    .tag-new-input {
      background: var(--color-bg, #1a1a1a);
    }
  }

  /* Responsive: match parent action bar layout */
  @container (max-width: 420px) {
    .action-btn {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.125rem;
      text-align: center;
    }
    .action-label {
      margin-left: 0;
      font-size: 0.75rem;
    }
  }

  @container (max-width: 320px) {
    .action-label {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .action-btn {
      font-size: 1.125rem;
    }

    .action-icon :global(.icon) {
      width: 20px;
      height: 20px;
    }

    .action-label {
      font-size: 0.9375rem;
    }
  }
</style>
