<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';
  import type { ErrorDetails } from '$lib/stores/feedStatus.svelte';

  interface Props {
    errorDetails: ErrorDetails;
  }

  let { errorDetails }: Props = $props();
</script>

<!-- Inline version of the sidebar/sources error popover, shown at the top of a
     single-feed view so a broken feed says so where the reader is looking —
     e.g. right after adding one the site turns out to block. -->
<div class="feed-error-notice" class:permanent={errorDetails.isPermanent} role="status">
  <span class="notice-icon" aria-hidden="true"><Icon name="alert-triangle" size={16} /></span>
  <div class="notice-body">
    <p class="notice-title">{errorDetails.title}</p>
    <p class="notice-description">{errorDetails.description}</p>
    {#if errorDetails.errorCount > 1}
      <p class="notice-meta">Failed {errorDetails.errorCount} times</p>
    {/if}
    {#if errorDetails.errorCode || errorDetails.rawError}
      <details class="notice-raw">
        <summary>Technical details</summary>
        {#if errorDetails.errorCode}
          <div class="notice-code">{errorDetails.errorCode}</div>
        {/if}
        {#if errorDetails.rawError}
          <code>{errorDetails.rawError}</code>
        {/if}
      </details>
    {/if}
  </div>
</div>

<style>
  .feed-error-notice {
    display: flex;
    gap: 0.75rem;
    margin: 0.75rem 1rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-warning, #ff9800);
    border-radius: 8px;
    background: var(--color-bg);
  }

  .feed-error-notice.permanent {
    border-left-color: var(--color-error);
  }

  .notice-icon {
    display: flex;
    flex-shrink: 0;
    padding-top: 0.125rem;
    color: var(--color-warning, #ff9800);
  }

  .feed-error-notice.permanent .notice-icon {
    color: var(--color-error);
  }

  .notice-body {
    min-width: 0;
    flex: 1;
  }

  .notice-title {
    margin: 0;
    font-weight: var(--weight-semibold);
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .notice-description {
    margin: 0.25rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
  }

  .notice-meta {
    margin: 0.25rem 0 0;
    font-size: var(--text-xs);
    color: var(--color-text-tertiary, var(--color-text-secondary));
  }

  .notice-raw {
    margin-top: 0.5rem;
    font-size: var(--text-xs);
  }

  .notice-raw summary {
    color: var(--color-text-tertiary, var(--color-text-secondary));
    cursor: pointer;
    user-select: none;
  }

  .notice-raw summary:hover {
    color: var(--color-text-secondary);
  }

  .notice-code {
    margin-top: 0.5rem;
    font-family: monospace;
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .notice-raw code {
    display: block;
    margin-top: 0.25rem;
    padding: 0.5rem;
    background: var(--color-bg-secondary);
    border-radius: 4px;
    font-family: monospace;
    font-size: var(--text-2xs);
    color: var(--color-text-secondary);
    word-break: break-all;
    white-space: pre-wrap;
  }
</style>
