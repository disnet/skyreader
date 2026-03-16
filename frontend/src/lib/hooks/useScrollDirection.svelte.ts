import { onMount, onDestroy } from 'svelte';

const SCROLL_THRESHOLD = 60;

export function useScrollDirection(options?: { onHide?: () => void }) {
  let controlsVisible = $state(true);
  let lastScrollY = $state(0);

  function handleScroll() {
    const currentY = window.scrollY;
    if (currentY > lastScrollY && currentY > SCROLL_THRESHOLD) {
      if (controlsVisible) {
        controlsVisible = false;
        options?.onHide?.();
      }
    } else {
      controlsVisible = true;
    }
    lastScrollY = currentY;
  }

  onMount(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
  });

  onDestroy(() => {
    window.removeEventListener('scroll', handleScroll);
  });

  return {
    get controlsVisible() {
      return controlsVisible;
    },
    handleScroll,
  };
}
