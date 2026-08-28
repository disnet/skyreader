<script lang="ts">
  import { appScrollElement, onAppScrollRootChange } from '$lib/utils/appScroll';

  interface Props {
    hasMore: boolean;
    isLoading: boolean;
    onLoadMore: () => void;
    rootMargin?: string;
  }

  let { hasMore, isLoading, onLoadMore, rootMargin = '400px' }: Props = $props();

  let sentinel = $state<HTMLDivElement>();

  // `appScrollElement()` is not reactive, so bump a counter when the shell
  // crosses its breakpoint and read it below: otherwise the observer stays
  // rooted on the pane after a resize down to mobile, where the pane no longer
  // scrolls, until the next isLoading flip happens to rebuild it.
  let rootEpoch = $state(0);
  $effect(() => onAppScrollRootChange(() => rootEpoch++));

  $effect(() => {
    if (!sentinel) return;

    // Tracked so the observer is rebuilt on the new root. See rootEpoch above.
    void rootEpoch;

    // Track isLoading so the observer is recreated when loading state changes.
    // This ensures that when an async load completes (isLoading: true → false)
    // and the sentinel is still in view, the new observer fires immediately.
    const _isLoading = isLoading;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading) {
          onLoadMore();
        }
      },
      // Rooted on whatever is actually scrolling: the framed content card on
      // desktop, the window on mobile (see utils/appScroll).
      { root: appScrollElement(), rootMargin: `0px 0px ${rootMargin} 0px` }
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  });
</script>

{#if hasMore}
  <div bind:this={sentinel} class="sentinel">
    {#if isLoading}
      <p class="loading-state">Loading more...</p>
    {/if}
  </div>
{/if}

<style>
  .sentinel {
    min-height: 1px;
  }

  .loading-state {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-secondary);
  }
</style>
