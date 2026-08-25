<script lang="ts">
  // Removing a highlight that's backed by an at.margin.note deletes that record
  // from the user's PDS too — which is correct (it's what stops a deleted
  // highlight resurrecting on the next Margin poll) but is a cross-app delete.
  // It must not be possible to do without seeing that said out loud.
  import Modal from '$lib/components/common/Modal.svelte';

  interface Props {
    open: boolean;
    /** The highlight is backed by a Margin record, so this deletes that too. */
    onMargin: boolean;
    onclose: () => void;
    onRemove: () => void;
  }

  let { open, onMargin, onclose, onRemove }: Props = $props();
</script>

<Modal {open} {onclose} title="Remove this highlight?" maxWidth="400px" zIndex={300}>
  <p class="prompt">
    {#if onMargin}
      This also removes it from Margin — the note on your PDS is deleted.
    {:else}
      It disappears from every device you read on.
    {/if}
  </p>

  {#snippet footer()}
    <button type="button" class="btn-text" onclick={onclose}>Cancel</button>
    <button type="button" class="btn-danger" onclick={onRemove}>Remove</button>
  {/snippet}
</Modal>

<style>
  .prompt {
    margin: 0;
    font-size: var(--text-md);
    line-height: var(--leading-relaxed, 1.5);
    color: var(--color-text);
  }

  .btn-danger,
  .btn-text {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .btn-danger {
    background: var(--color-error, #cc0000);
    color: white;
    border: none;
  }

  .btn-danger:hover {
    filter: brightness(0.92);
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
