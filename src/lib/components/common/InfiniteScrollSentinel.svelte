<script lang="ts">
  interface Props {
    hasMore: boolean;
    isLoading: boolean;
    onLoadMore: () => void;
    rootMargin?: string;
  }

  let { hasMore, isLoading, onLoadMore, rootMargin = '400px' }: Props = $props();

  let sentinel = $state<HTMLDivElement>();

  $effect(() => {
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading) {
          onLoadMore();
        }
      },
      { rootMargin: `0px 0px ${rootMargin} 0px` }
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
