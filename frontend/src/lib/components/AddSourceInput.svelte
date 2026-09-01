<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { on } from 'svelte/events';
  import { goto } from '$app/navigation';
  import Icon from '$lib/components/Icon.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { auth } from '$lib/stores/auth.svelte';

  // Open state lives in the store so the keyboard shortcut ("a") can toggle
  // this menu as well as the trigger button.
  let isOpen = $derived(sidebarStore.addMenuOpen);
  let inputValue = $state('');
  let inputRef: HTMLInputElement | null = $state(null);
  let buttonRef: HTMLButtonElement | null = $state(null);
  let menuRef: HTMLDivElement | null = $state(null);
  let menuPosition = $state<{ top: number; left: number }>({ top: 0, left: 0 });

  // Detect what the user is typing
  let inputType = $derived.by((): 'handle' | 'url' | 'unknown' => {
    const v = inputValue.trim();
    if (!v) return 'unknown';
    if (v.startsWith('@')) return 'handle';
    if (v.startsWith('http://') || v.startsWith('https://')) return 'url';
    if (!v.includes('/') && /^[\w.-]+\.\w+$/.test(v)) return 'handle';
    return 'unknown';
  });

  function updateMenuPosition() {
    if (!buttonRef) return;
    const rect = buttonRef.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const menuWidth = 260;

    let top = rect.bottom + 4;
    let left = rect.left;

    if (left + menuWidth > viewportWidth - 8) {
      left = rect.right - menuWidth;
    }
    if (left < 8) left = 8;

    menuPosition = { top, left };
  }

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    sidebarStore.toggleAddMenu();
  }

  // On open (from a click or the keyboard shortcut), reset the input, position
  // the menu, and focus the field. Effects run after the DOM update, so the
  // input and the trigger are both measurable here — doing this synchronously
  // rather than in a rAF keeps the reset, the position and the focus in one
  // step, so nothing can land in the field between the reset and the focus.
  $effect(() => {
    if (isOpen) {
      inputValue = '';
      updateMenuPosition();
      inputRef?.focus();
    }
  });

  // The menu is portaled to <body>, outside the app's mount root, so Svelte's
  // delegated handlers reach it only through the document-level fallback
  // listener. Bind keydown straight to the node instead: submitting with Enter
  // shouldn't depend on that path.
  $effect(() => {
    if (!inputRef) return;
    return on(inputRef, 'keydown', handleKeydown);
  });

  function close() {
    sidebarStore.closeAddMenu();
    inputValue = '';
  }

  function handleSubmit() {
    const v = inputValue.trim();
    if (!v) return;

    close();

    // Following an Atmosphere account writes a subscription record to the
    // reader's own repo, so it needs one. A guest gets the sign-in screen.
    if (auth.isGuest && inputType === 'handle') {
      goto('/auth/login?returnUrl=/feeds');
      return;
    }

    if (inputType === 'handle') {
      const handle = v.startsWith('@') ? v.slice(1) : v;
      sidebarStore.setAddSourceInitialValue(handle);
      sidebarStore.openAddHandleModal();
    } else {
      sidebarStore.setAddSourceInitialValue(v);
      sidebarStore.openAddFeedModal();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function handleAction(action: () => void, e: MouseEvent) {
    e.stopPropagation();
    close();
    sidebarStore.closeNavigationDropdown();
    action();
  }

  function handleClickOutside(e: MouseEvent) {
    if (
      isOpen &&
      menuRef &&
      buttonRef &&
      !menuRef.contains(e.target as Node) &&
      !buttonRef.contains(e.target as Node)
    ) {
      close();
    }
  }

  function handleEscape(e: KeyboardEvent) {
    if (isOpen && e.key === 'Escape') {
      close();
      buttonRef?.focus();
    }
  }

  // Portal action to move element to body (escapes overflow:hidden ancestors)
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
  });

  onDestroy(() => {
    document.removeEventListener('click', handleClickOutside);
    document.removeEventListener('keydown', handleEscape);
  });
</script>

<div class="add-source">
  <button
    bind:this={buttonRef}
    class="add-trigger"
    onclick={toggle}
    aria-haspopup="true"
    aria-expanded={isOpen}
    aria-label="Add source"
  >
    <Icon name="plus" size={16} />
  </button>

  {#if isOpen}
    <div use:portal>
      <div
        bind:this={menuRef}
        class="add-menu"
        style="top: {menuPosition.top}px; left: {menuPosition.left}px;"
      >
        <div class="menu-input-row">
          <span class="input-icon">
            {#if inputType === 'handle'}
              <Icon name="at-sign" size={14} />
            {:else if inputType === 'url'}
              <Icon name="link" size={14} />
            {:else}
              <Icon name="search" size={14} />
            {/if}
          </span>
          <input
            bind:this={inputRef}
            bind:value={inputValue}
            placeholder={auth.isGuest ? 'Paste a feed URL...' : 'Paste URL or @handle...'}
            class="menu-input"
          />
          {#if inputValue.trim()}
            <button class="go-btn" onclick={handleSubmit}>
              <Icon name="arrow-right" size={14} />
            </button>
          {/if}
        </div>
        <div class="menu-divider"></div>
        <button
          class="menu-item"
          onclick={(e) => handleAction(() => sidebarStore.openAddFeedModal(), e)}
        >
          <span class="item-icon"><Icon name="rss" size={16} /></span>
          Add RSS Feed
        </button>
        {#if auth.isGuest}
          <!-- Feed saves are local for a guest; following an @handle and saving
               arbitrary URLs (extraction is session-gated) still need an account. -->
          <button
            class="menu-item"
            onclick={(e) => handleAction(() => goto('/auth/login?returnUrl=/feeds'), e)}
          >
            <span class="item-icon"><Icon name="user" size={16} /></span>
            Sign in to sync & follow accounts
          </button>
        {:else}
          <button
            class="menu-item"
            onclick={(e) => handleAction(() => sidebarStore.openAddHandleModal(), e)}
          >
            <span class="item-icon"><Icon name="users" size={16} /></span>
            Add Atmosphere account
          </button>
          <button
            class="menu-item"
            onclick={(e) => handleAction(() => sidebarStore.openSaveArticleModal(), e)}
          >
            <span class="item-icon"><Icon name="bookmark" size={16} /></span>
            Save article by URL
          </button>
          <button
            class="menu-item"
            onclick={(e) => handleAction(() => goto('/settings#save-anywhere'), e)}
          >
            <span class="item-icon"><Icon name="share" size={16} /></span>
            Save from anywhere
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .add-source {
    position: relative;
    display: inline-flex;
  }

  .add-trigger {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem 0.375rem;
    border: none;
    background: transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.2s,
      color 0.2s;
  }

  .add-trigger:hover {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  /* Menu is portaled to body, so styles must be global */
  :global(.add-menu) {
    position: fixed;
    width: 260px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 9999;
    overflow: hidden;
  }

  :global(.add-menu .menu-input-row) {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
  }

  :global(.add-menu .input-icon) {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
  }

  :global(.add-menu .menu-input) {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-text);
    outline: none;
    padding: 0.125rem 0;
  }

  :global(.add-menu .menu-input::placeholder) {
    color: var(--color-text-secondary);
  }

  :global(.add-menu .go-btn) {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.125rem;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--color-primary);
    border-radius: 4px;
  }

  :global(.add-menu .go-btn:hover) {
    background: rgba(0, 102, 204, 0.1);
  }

  :global(.add-menu .menu-divider) {
    height: 1px;
    background: var(--color-border);
  }

  :global(.add-menu .menu-item) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: none;
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  :global(.add-menu .menu-item:hover) {
    background: var(--color-bg-secondary);
  }

  :global(.add-menu .item-icon) {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
  }

  @media (prefers-color-scheme: dark) {
    :global(.add-menu) {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
  }
</style>
