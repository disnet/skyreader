import { onMount, onDestroy } from 'svelte';
import { appScrollTop, onAppScroll } from '$lib/utils/appScroll';

const SCROLL_THRESHOLD = 60;

export function useScrollDirection(options?: { onHide?: () => void }) {
  let controlsVisible = $state(true);
  let lastScrollY = $state(0);

  function handleScroll() {
    const currentY = appScrollTop();
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

  let stop: (() => void) | null = null;

  onMount(() => {
    stop = onAppScroll(handleScroll);
  });

  onDestroy(() => {
    stop?.();
    stop = null;
  });

  return {
    get controlsVisible() {
      return controlsVisible;
    },
    handleScroll,
  };
}
