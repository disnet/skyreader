<script lang="ts" module>
  export interface ShareMenuItem {
    label: string;
    /** A quiet second line saying where it goes. */
    hint?: string;
    icon: IconName;
    /** Lit: already done here (e.g. shared to the linkblog). */
    active?: boolean;
    onclick: () => void;
  }
</script>

<script lang="ts">
  // The reader's Share button opens this: the places a piece can go from here
  // (your linkblog, Bluesky, its public discussion page). Non-modal, like the
  // Save panel: a click outside, a scroll gesture or Escape puts it away.
  // Desktop hangs it under the button; on a phone it sits above the bottom bar.
  import { onMount, tick } from 'svelte';
  import Icon, { type IconName } from '$lib/components/Icon.svelte';

  interface Props {
    items: ShareMenuItem[];
    anchorEl: HTMLElement | null | undefined;
    placement?: 'below' | 'above';
    onClose: () => void;
  }

  let { items, anchorEl, placement = 'below', onClose }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);

  function close(refocus = false) {
    onClose();
    if (refocus) anchorEl?.focus();
  }

  function position() {
    if (!anchorEl || !menuEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const gap = 8;
    if (placement === 'above') {
      menuEl.style.bottom = `${window.innerHeight - rect.top + gap}px`;
      return;
    }
    const width = menuEl.offsetWidth;
    // Left edge under the button's, kept on screen.
    const left = Math.min(Math.max(gap, rect.left), window.innerWidth - width - gap);
    menuEl.style.top = `${rect.bottom + gap}px`;
    menuEl.style.left = `${Math.max(gap, left)}px`;
  }

  function inside(target: EventTarget | null): boolean {
    const node = target as Node | null;
    return Boolean(node && (menuEl?.contains(node) || anchorEl?.contains(node)));
  }

  function onPointerDown(e: PointerEvent) {
    if (!inside(e.target)) close();
  }

  function onScrollGesture(e: Event) {
    if (!inside(e.target)) close();
  }

  function itemButtons(): HTMLButtonElement[] {
    return Array.from(menuEl?.querySelectorAll<HTMLButtonElement>('.share-item') ?? []);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = itemButtons();
    if (buttons.length === 0) return;
    e.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at === -1 ? 0 : (at + step + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  function choose(item: ShareMenuItem) {
    onClose();
    item.onclick();
  }

  onMount(() => {
    position();
    void tick().then(() => itemButtons()[0]?.focus({ preventScroll: true }));
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('wheel', onScrollGesture, { capture: true, passive: true });
    document.addEventListener('touchmove', onScrollGesture, { capture: true, passive: true });
    window.addEventListener('resize', position);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('wheel', onScrollGesture, true);
      document.removeEventListener('touchmove', onScrollGesture, true);
      window.removeEventListener('resize', position);
    };
  });
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="share-menu"
  class:above={placement === 'above'}
  role="menu"
  aria-label="Share"
  bind:this={menuEl}
  onkeydown={onKeydown}
>
  {#each items as item (item.label)}
    <button
      class="share-item"
      class:active={item.active}
      role="menuitem"
      onclick={() => choose(item)}
    >
      <span class="share-icon"><Icon name={item.icon} size={18} /></span>
      <span class="share-text">
        <span class="share-label">{item.label}</span>
        {#if item.hint}<span class="share-hint">{item.hint}</span>{/if}
      </span>
    </button>
  {/each}
</div>

<style>
  .share-menu {
    position: fixed;
    z-index: 1000;
    width: max-content;
    min-width: 220px;
    max-width: min(320px, calc(100vw - 16px));
    padding: 0.25rem;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    /* Floating over the page: the one place a shadow belongs. */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  /* The phone: over the bottom bar, the screen's width less a gutter. */
  .share-menu.above {
    left: 12px;
    right: 12px;
    width: auto;
    max-width: none;
  }

  .share-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    text-align: left;
    cursor: pointer;
  }

  .share-item:hover,
  .share-item:focus-visible {
    background: var(--color-bg-secondary);
    outline: none;
  }

  .share-icon {
    display: flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .share-item.active .share-icon {
    color: var(--color-primary);
  }

  .share-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .share-hint {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  @media (hover: none) and (pointer: coarse) {
    .share-item {
      min-height: 48px;
    }
  }
</style>
