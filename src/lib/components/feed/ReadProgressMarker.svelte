<script lang="ts">
  let {
    currentParagraphIndex,
    furthestParagraphIndex,
    totalParagraphs,
  }: {
    currentParagraphIndex: number;
    furthestParagraphIndex: number;
    totalParagraphs: number;
  } = $props();

  let progress = $derived(
    totalParagraphs > 0 ? Math.round((currentParagraphIndex / (totalParagraphs - 1)) * 100) : 0
  );

  let furthestProgress = $derived(
    totalParagraphs > 0 ? Math.round((furthestParagraphIndex / (totalParagraphs - 1)) * 100) : 0
  );

  let showResume = $derived(
    furthestParagraphIndex > currentParagraphIndex && furthestParagraphIndex < totalParagraphs - 1
  );
</script>

{#if totalParagraphs > 1}
  <div class="read-progress-marker">
    <div class="progress-track">
      {#if showResume}
        <div
          class="furthest-marker"
          style="top: {furthestProgress}%"
          title="Furthest read position"
        ></div>
      {/if}
      <div class="current-marker" style="top: {progress}%"></div>
    </div>
    <span class="progress-text">
      &para; {currentParagraphIndex + 1}/{totalParagraphs}
    </span>
  </div>
{/if}

<style>
  .read-progress-marker {
    position: absolute;
    left: -20px;
    top: 0;
    bottom: 0;
    width: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none;
    z-index: 1;
  }

  .progress-track {
    position: relative;
    width: 3px;
    flex: 1;
    background: var(--color-border);
    border-radius: 2px;
    min-height: 40px;
  }

  .current-marker {
    position: absolute;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-primary);
    transition: top 0.2s ease;
  }

  .furthest-marker {
    position: absolute;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-text-secondary, #999);
    opacity: 0.5;
    transition: top 0.2s ease;
  }

  .progress-text {
    font-size: 0.65rem;
    color: var(--color-text-secondary);
    white-space: nowrap;
    margin-top: 4px;
    font-variant-numeric: tabular-nums;
  }
</style>
