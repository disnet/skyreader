<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    searchQuery: string;
    onSearchChange: (value: string) => void;
    onAddRss: () => void;
    onAddHandle: () => void;
  }

  let { searchQuery, onSearchChange, onAddRss, onAddHandle }: Props = $props();

  let menuOpen = $state(false);
  let wrapperRef = $state<HTMLDivElement | null>(null);

  function pick(action: () => void) {
    menuOpen = false;
    action();
  }

  $effect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (wrapperRef && !wrapperRef.contains(e.target as Node)) menuOpen = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') menuOpen = false;
    }
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="sources-toolbar">
  <div class="search-wrapper">
    <Icon name="search" size={16} />
    <input
      type="text"
      value={searchQuery}
      oninput={(e) => onSearchChange(e.currentTarget.value)}
      placeholder="Search sources..."
      class="search-input"
    />
  </div>

  <div class="add-wrapper" bind:this={wrapperRef}>
    <button
      class="add-btn"
      onclick={() => (menuOpen = !menuOpen)}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
    >
      <Icon name="plus" size={16} />
      <span class="add-label">Add source</span>
      <Icon name="chevron-down" size={14} />
    </button>
    {#if menuOpen}
      <div class="add-menu" role="menu">
        <button class="add-item" role="menuitem" onclick={() => pick(onAddRss)}>
          <Icon name="rss" size={16} />
          <span class="item-text">
            <span class="item-label">RSS feed</span>
            <span class="item-hint">A blog or site URL</span>
          </span>
        </button>
        <button class="add-item" role="menuitem" onclick={() => pick(onAddHandle)}>
          <Icon name="at-sign" size={16} />
          <span class="item-text">
            <span class="item-label">Atmosphere account</span>
            <span class="item-hint">A @handle's blogs &amp; links</span>
          </span>
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .sources-toolbar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 1rem;
  }

  .search-wrapper {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    color: var(--color-text-secondary);
  }

  .search-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text);
    outline: none;
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .add-wrapper {
    position: relative;
    flex-shrink: 0;
  }

  .add-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    border: none;
    border-radius: 8px;
    background: var(--color-primary);
    color: #fff;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    white-space: nowrap;
    transition: background-color 0.2s;
  }

  .add-btn:hover {
    background: var(--color-primary-dark, #0052a3);
  }

  .add-menu {
    position: absolute;
    top: calc(100% + 0.375rem);
    right: 0;
    z-index: 100;
    min-width: 240px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 0.25rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  .add-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    color: var(--color-text);
  }

  .add-item:hover {
    background: var(--color-bg-secondary, rgba(0, 0, 0, 0.04));
  }

  .add-item > :global(svg) {
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .item-text {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
  }

  .item-label {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .item-hint {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  @media (max-width: 640px) {
    .add-label {
      display: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .search-wrapper {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.06));
    }

    .add-menu {
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .add-item:hover {
      background: var(--color-bg-secondary, rgba(255, 255, 255, 0.06));
    }
  }
</style>
