<script lang="ts">
  import Modal from '$lib/components/common/Modal.svelte';

  interface Props {
    open: boolean;
    count: number;
    // What the issue was built from: saves offer "archive all", feeds "mark all read".
    source?: 'saved' | 'feeds';
    onclose: () => void;
    // alsoClearArticles=true archives the issue's saved articles too (or marks a
    // feeds issue's articles read); false dismisses just the issue.
    onArchive: (alsoClearArticles: boolean) => void;
  }

  let { open, count, source = 'saved', onclose, onArchive }: Props = $props();
  let articles = $derived(`${count} article${count === 1 ? '' : 's'}`);
</script>

<!-- zIndex above the full-screen daily reader (.daily-reader is z-index: 100) so
     the modal isn't painted behind it. -->
<Modal {open} {onclose} title="Archive this issue?" maxWidth="400px" zIndex={300}>
  <p class="prompt">
    {#if source === 'feeds'}
      This issue drops off Home. You can also mark its {articles} read.
    {:else}
      This issue drops off Home. You can also archive its {articles} to clear them from your saved inbox.
    {/if}
  </p>

  {#snippet footer()}
    <button type="button" class="btn-text" onclick={onclose}>Cancel</button>
    <button type="button" class="btn-secondary" onclick={() => onArchive(false)}>Issue only</button>
    <button type="button" class="btn-primary" onclick={() => onArchive(true)}>
      {source === 'feeds' ? 'Mark all read' : 'Archive all'}
    </button>
  {/snippet}
</Modal>

<style>
  .prompt {
    margin: 0;
    font-size: var(--text-md);
    line-height: var(--leading-relaxed, 1.5);
    color: var(--color-text);
  }

  .btn-primary,
  .btn-secondary,
  .btn-text {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .btn-primary {
    background: var(--color-primary);
    color: white;
    border: none;
  }

  .btn-primary:hover {
    background: var(--color-primary-dark, #0056b3);
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover {
    background: var(--color-bg-secondary);
  }

  .btn-text {
    background: none;
    border: none;
    color: var(--color-text-secondary);
  }

  .btn-text:hover {
    color: var(--color-text);
  }
</style>
