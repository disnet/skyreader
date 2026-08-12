<script lang="ts">
  import { appManager } from '$lib/stores/app.svelte';
  import { bottomRail } from '$lib/stores/bottomRail.svelte';

  let visible = $state(false);
  let completing = $state(false);

  $effect(() => {
    if (appManager.isRefreshing) {
      visible = true;
      completing = false;
    } else if (visible) {
      // Play completion animation then hide
      completing = true;
      const timer = setTimeout(() => {
        visible = false;
        completing = false;
      }, 400);
      return () => clearTimeout(timer);
    }
  });
</script>

{#if visible}
  <div class="progress-bar" class:completing class:standing-down={bottomRail.claimed}>
    <div class="bar"></div>
  </div>
{/if}

<style>
  .progress-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    z-index: 500;
    overflow: hidden;
    background: transparent;
  }

  .bar {
    height: 100%;
    background: var(--color-primary, #0066cc);
    animation: indeterminate 1.2s ease-in-out infinite;
    transform-origin: left;
  }

  .completing .bar {
    animation: complete 0.3s ease-out forwards;
  }

  @keyframes indeterminate {
    0% {
      transform: translateX(-100%) scaleX(0.3);
    }
    50% {
      transform: translateX(0%) scaleX(0.5);
    }
    100% {
      transform: translateX(100%) scaleX(0.3);
    }
  }

  @keyframes complete {
    from {
      transform: translateX(0) scaleX(1);
      opacity: 1;
    }
    to {
      transform: translateX(0) scaleX(1);
      opacity: 0;
    }
  }

  /* Mobile has no top chrome to hang this from, and a bottom bar's own rail
     already carries the same sweep at the edge the thumb and eye are on. Two
     indicators for one refresh is one too many, so this stands down — but only
     while a bar is actually claiming the job (see the bottomRail store). A bar
     that has slid away on scroll hands it back rather than leaving mobile with
     no indicator at all. */
  @media (max-width: 1000px) {
    .progress-bar.standing-down {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar {
      animation: none;
      opacity: 0.6;
    }

    .completing .bar {
      animation: none;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
  }
</style>
