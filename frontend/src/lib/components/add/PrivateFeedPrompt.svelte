<script lang="ts">
  import { privateFeedReason, type PrivateFeedSignal } from '$lib/utils/privateFeed';

  /**
   * Asked before a feed that looks private joins a feed list that Atmospheric
   * sync makes public. Keeping it private is the first choice: the reader
   * still gets the feed everywhere they use Skyreader, it just isn't published.
   */
  interface Props {
    feedUrl: string;
    signal: PrivateFeedSignal;
    busy?: boolean;
    onKeepPrivate: () => void;
    onSyncAnyway: () => void;
    onCancel: () => void;
  }

  let { feedUrl, signal, busy = false, onKeepPrivate, onSyncAnyway, onCancel }: Props = $props();
</script>

<div class="private-prompt">
  <p class="heading">This looks like a private feed</p>
  <p class="feed-url">{feedUrl}</p>
  <p class="body">
    {privateFeedReason(signal)} Atmospheric sync publishes your feed list on your PDS, where anyone can
    see it, link included. Anyone with the link could read this feed as you.
  </p>
  <div class="actions">
    <button class="primary" onclick={onKeepPrivate} disabled={busy}>Keep it private</button>
    <button class="secondary" onclick={onSyncAnyway} disabled={busy}>Sync it publicly</button>
    <button class="text" onclick={onCancel} disabled={busy}>Cancel</button>
  </div>
  <p class="aside">
    A private feed stays on Skyreader's servers only. It still works on all your devices.
  </p>
</div>

<style>
  .private-prompt {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .heading {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  .feed-url {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    word-break: break-all;
  }

  .body,
  .aside {
    margin: 0;
    font-size: var(--text-md);
    line-height: 1.5;
    color: var(--color-text);
  }

  .aside {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .actions button {
    padding: 0.5rem 0.875rem;
    border-radius: 8px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .primary {
    border: none;
    background: var(--color-primary, #0066cc);
    color: white;
  }

  .secondary {
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text);
  }

  .text {
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
  }

  .secondary:hover:not(:disabled),
  .text:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }
</style>
