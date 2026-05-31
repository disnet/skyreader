<script lang="ts">
  interface Props {
    message?: string;
    /** Number of skeleton rows to render */
    count?: number;
  }

  let { message = 'Loading articles…', count = 6 }: Props = $props();

  const rows = $derived(Array.from({ length: count }, (_, i) => i));
</script>

<div class="loading-state" role="status" aria-live="polite" aria-busy="true">
  <span class="sr-only">{message}</span>
  {#each rows as i (i)}
    <div class="skeleton-row" aria-hidden="true">
      <span class="sk sk-dot"></span>
      <div class="skeleton-lines">
        <span class="sk sk-title"></span>
        <span class="sk sk-meta"></span>
      </div>
    </div>
  {/each}
</div>

<style>
  .loading-state {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Mirrors ArticleCard's collapsed row: read-dot + title line + meta line */
  .skeleton-row {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.625rem 1rem;
  }

  .skeleton-lines {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 1px;
  }

  .sk {
    display: block;
    border-radius: 4px;
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .sk-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 4px;
  }

  .sk-title {
    height: 0.9rem;
    width: 70%;
  }

  .sk-meta {
    height: 0.7rem;
    width: 35%;
  }

  /* Vary the title width so the column reads as real content, not a grid */
  .skeleton-row:nth-child(2n) .sk-title {
    width: 55%;
  }
  .skeleton-row:nth-child(3n) .sk-title {
    width: 82%;
  }
  .skeleton-row:nth-child(2n) .sk-meta {
    width: 28%;
  }

  /* Shimmer: a soft highlight sweeping left→right */
  .sk {
    position: relative;
    overflow: hidden;
  }

  .sk::after {
    content: '';
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
    animation: shimmer 1.4s ease-in-out infinite;
  }

  @keyframes shimmer {
    100% {
      transform: translateX(100%);
    }
  }

  @media (prefers-color-scheme: dark) {
    .sk {
      background: var(--color-bg-secondary, #2a2a2a);
    }
    .sk::after {
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.08), transparent);
    }
  }

  /* Reduced motion: hold a calm static placeholder, no sweep */
  @media (prefers-reduced-motion: reduce) {
    .sk::after {
      display: none;
    }
  }
</style>
