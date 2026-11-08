<script lang="ts">
  // The reader's Style button opens this: font and size, hung under the button
  // like the Share menu and the Save panel. Non-modal: a pick applies at once and
  // the menu stays up so the reader can keep adjusting; a click outside, a scroll
  // gesture or tabbing away puts it away. Escape belongs to the host reader,
  // whose capture-phase shortcuts see it first: it closes this, not the reader.
  import { onMount, tick } from 'svelte';
  import StyleOptions from './StyleOptions.svelte';

  interface Props {
    anchorEl: HTMLElement | null | undefined;
    onClose: () => void;
  }

  let { anchorEl, onClose }: Props = $props();

  let menuEl = $state<HTMLDivElement | null>(null);

  function close(refocus = false) {
    onClose();
    if (refocus) anchorEl?.focus();
  }

  function position() {
    if (!anchorEl || !menuEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const gap = 8;
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

  // Tabbing away puts it away, so a stray menu never sits open behind the
  // focus. (A click that drops focus to the page counts as outside already.)
  function onFocusOut(e: FocusEvent) {
    if (e.relatedTarget && !inside(e.relatedTarget)) close();
  }

  onMount(() => {
    position();
    void tick().then(() =>
      menuEl
        ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?.focus({ preventScroll: true })
    );
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

<div class="style-menu" role="dialog" aria-label="Style" bind:this={menuEl} onfocusout={onFocusOut}>
  <StyleOptions />
</div>

<style>
  .style-menu {
    position: fixed;
    z-index: 1000;
    width: 240px;
    max-width: calc(100vw - 16px);
    padding: 0.25rem;
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    /* Floating over the page: the one place a shadow belongs. */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }
</style>
