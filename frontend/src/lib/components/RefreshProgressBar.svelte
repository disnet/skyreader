<script lang="ts">
  import { appManager } from '$lib/stores/app.svelte';

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
  <div class="progress-bar" class:completing>
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
</style>
