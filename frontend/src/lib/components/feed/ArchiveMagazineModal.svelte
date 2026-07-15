<script lang="ts">
  import Modal from '$lib/components/common/Modal.svelte';

  interface Props {
    open: boolean;
    count: number;
    onclose: () => void;
    // alsoArchiveArticles=true archives the issue's articles too; false dismisses
    // just the issue and leaves its articles in the saved inbox.
    onArchive: (alsoArchiveArticles: boolean) => void;
  }

  let { open, count, onclose, onArchive }: Props = $props();
</script>

<!-- zIndex above the full-screen daily reader (.daily-reader is z-index: 100) so
     the modal isn't painted behind it. -->
<Modal {open} {onclose} title="Archive this issue?" maxWidth="400px" zIndex={300}>
  <p class="prompt">
    This issue drops off Home. You can also archive its {count}
    article{count === 1 ? '' : 's'} to clear them from your saved inbox.
  </p>

  {#snippet footer()}
    <button type="button" class="btn-text" onclick={onclose}>Cancel</button>
    <button type="button" class="btn-secondary" onclick={() => onArchive(false)}>Issue only</button>
    <button type="button" class="btn-primary" onclick={() => onArchive(true)}>Archive all</button>
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
