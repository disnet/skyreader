<script lang="ts">
  // The reader's Style button opens this: font and size, hung under the button
  // like the Share menu and the Save panel. Non-modal: a pick applies at once and
  // the menu stays up so the reader can keep adjusting; a click outside, a scroll
  // gesture or tabbing away puts it away. Escape belongs to the host reader,
  // whose capture-phase shortcuts see it first: it closes this, not the reader.
  import { onMount, tick } from 'svelte';
  import { outsideDismiss } from '$lib/utils/outsideDismiss';
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

  const dismiss = outsideDismiss(
    () => [menuEl, anchorEl],
    () => close()
  );

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

  onMount(() => {
    position();
    void tick().then(() =>
      menuEl
        ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?.focus({ preventScroll: true })
    );
    const stopDismiss = dismiss.listen();
    window.addEventListener('resize', position);
    return () => {
      stopDismiss();
      window.removeEventListener('resize', position);
    };
  });
</script>

<div
  class="style-menu"
  role="dialog"
  aria-label="Style"
  bind:this={menuEl}
  onfocusout={dismiss.onFocusOut}
>
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
