<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  interface Props {
    url: string;
    linkText: string;
    anchorRect: DOMRect;
    onClose: () => void;
  }

  let { url, linkText, anchorRect, onClose }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);
  let copyState = $state<'idle' | 'copied'>('idle');

  function handleOpenInNewTab() {
    window.open(url, '_blank', 'noopener');
    onClose();
  }

  function handleSave() {
    const saveUrl = url;
    const toastId = toastStore.add('Saving article...');
    onClose();
    savesStore
      .saveFromUrl(saveUrl)
      .then(() => toastStore.update(toastId, 'success', 'Article saved'))
      .catch(() => toastStore.update(toastId, 'error', 'Failed to save article'));
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      copyState = 'copied';
      setTimeout(onClose, 600);
    } catch {
      copyState = 'idle';
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }

  function positionMenu() {
    if (!menuEl) return;
    const menuRect = menuEl.getBoundingClientRect();
    const gap = 4;

    let top: number;
    if (anchorRect.bottom + gap + menuRect.height > window.innerHeight) {
      top = Math.max(gap, anchorRect.top - gap - menuRect.height);
    } else {
      top = anchorRect.bottom + gap;
    }

    let left = Math.min(anchorRect.left, window.innerWidth - menuRect.width - gap);
    left = Math.max(gap, left);

    menuEl.style.top = `${top}px`;
    menuEl.style.left = `${left}px`;
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('click', handleClickOutside, true);
    document.addEventListener('scroll', onClose, true);
    requestAnimationFrame(positionMenu);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('click', handleClickOutside, true);
    document.removeEventListener('scroll', onClose, true);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
  class="link-menu"
  style="position: fixed; z-index: 200;"
  bind:this={menuEl}
  onclick={(e) => e.stopPropagation()}
>
  <div class="link-url">{linkText || url}</div>
  <div class="menu-divider"></div>
  <button class="menu-item" onclick={handleOpenInNewTab}>
    <Icon name="external-link" size={15} />
    <span>Open in new tab</span>
  </button>
  <button class="menu-item" onclick={handleSave}>
    <Icon name="bookmark" size={15} />
    <span>Add to saved</span>
  </button>
  <button class="menu-item" onclick={handleCopy}>
    <Icon name="copy" size={15} />
    <span>{copyState === 'copied' ? 'Copied!' : 'Copy URL'}</span>
  </button>
</div>

<style>
  .link-menu {
    min-width: 180px;
    max-width: 280px;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    padding: 0.25rem 0;
  }

  .link-url {
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-divider {
    height: 1px;
    background: var(--color-border, #e5e7eb);
    margin: 0.25rem 0;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8125rem;
    color: var(--color-text);
    width: 100%;
    text-align: left;
  }

  .menu-item:hover {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .menu-item:disabled {
    opacity: 0.6;
    cursor: default;
  }

  @media (prefers-color-scheme: dark) {
    .link-menu {
      background: var(--color-bg, #1a1a1a);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .menu-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }
  }
</style>
