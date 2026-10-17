<script lang="ts">
  import { fade } from 'svelte/transition';
  import { lightbox } from '$lib/stores/lightbox.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';
  import { beforeNavigate } from '$app/navigation';
  import Icon from '$lib/components/Icon.svelte';

  // Svelte's transitions don't read the OS setting themselves.
  const reduceMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = (ms: number) => (reduceMotion ? 0 : ms);

  let closeButton = $state<HTMLButtonElement>();

  // Navigating away (the back gesture included) closes the image, not the page
  // under it.
  beforeNavigate(() => lightbox.close());

  $effect(() => {
    if (!lightbox.current) return;
    const resume = keyboardStore.suspend();
    const returnFocus = document.activeElement as HTMLElement | null;
    closeButton?.focus();
    // Capture on window runs ahead of the reader's own Escape (close the
    // article), so Escape here closes only the image.
    function onKeydown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      lightbox.close();
    }
    window.addEventListener('keydown', onKeydown, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      resume();
      window.removeEventListener('keydown', onKeydown, true);
      document.body.style.overflow = overflow;
      returnFocus?.focus?.({ preventScroll: true });
    };
  });
</script>

{#if lightbox.current}
  {@const image = lightbox.current}
  <div
    class="lightbox"
    role="dialog"
    aria-modal="true"
    aria-label={image.alt || 'Image'}
    tabindex="-1"
    transition:fade={{ duration: motion(150) }}
    onclick={() => lightbox.close()}
    onkeydown={(e) => e.key === 'Tab' && (e.preventDefault(), closeButton?.focus())}
  >
    <button bind:this={closeButton} class="lightbox-close" aria-label="Close image">
      <Icon name="x" size={22} />
    </button>
    <figure>
      <img src={image.src} alt={image.alt} />
      {#if image.alt}
        <figcaption>{image.alt}</figcaption>
      {/if}
    </figure>
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(var(--safe-area-top) + 3.5rem) calc(var(--safe-area-right) + 1rem)
      calc(var(--safe-area-bottom) + 1rem) calc(var(--safe-area-left) + 1rem);
    background: rgba(0, 0, 0, 0.9);
    cursor: zoom-out;
    outline: none;
  }

  figure {
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    max-width: 100%;
    max-height: 100%;
    min-height: 0;
  }

  img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    min-height: 0;
    object-fit: contain;
    border-radius: 4px;
    /* Transparent PNGs and dark diagrams stay legible on the black. */
    background: #fff;
  }

  figcaption {
    flex-shrink: 0;
    max-width: 60ch;
    max-height: 4.5em;
    overflow-y: auto;
    color: rgba(255, 255, 255, 0.85);
    font-size: var(--text-md);
    line-height: var(--leading-normal);
    text-align: center;
  }

  .lightbox-close {
    position: absolute;
    top: calc(var(--safe-area-top) + 0.75rem);
    right: calc(var(--safe-area-right) + 0.75rem);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    cursor: pointer;
  }

  .lightbox-close:hover {
    background: rgba(255, 255, 255, 0.22);
  }

  .lightbox-close:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
</style>
