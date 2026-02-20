<script lang="ts">
  let {
    currentParagraphIndex,
    totalParagraphs,
  }: {
    currentParagraphIndex: number;
    totalParagraphs: number;
  } = $props();

  let segmentTop = $derived(
    totalParagraphs > 0 ? (currentParagraphIndex / totalParagraphs) * 100 : 0
  );

  let segmentHeight = $derived(
    totalParagraphs > 0 ? (1 / totalParagraphs) * 100 : 0
  );
</script>

{#if totalParagraphs > 1}
  <div class="read-progress-marker">
    <div class="progress-track">
      <div
        class="current-line"
        style="top: {segmentTop}%; height: {segmentHeight}%"
      ></div>
    </div>
  </div>
{/if}

<style>
  .read-progress-marker {
    position: absolute;
    left: -12px;
    top: 0;
    bottom: 0;
    width: 3px;
    pointer-events: none;
    z-index: 1;
  }

  .progress-track {
    position: relative;
    width: 3px;
    height: 100%;
    background: var(--color-border);
    border-radius: 2px;
  }

  .current-line {
    position: absolute;
    left: 0;
    width: 100%;
    background: var(--color-primary, #3b82f6);
    border-radius: 2px;
    transition: top 0.15s ease, height 0.15s ease;
  }
</style>
