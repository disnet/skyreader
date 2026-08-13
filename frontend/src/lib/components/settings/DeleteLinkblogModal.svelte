<script lang="ts">
  // Typed confirmation for the one linkblog action that destroys PDS records.
  // The typed word is the point: deletion walks the user's whole document
  // collection and nothing comes back, so it takes more than a misclickable
  // button. (This replaced a native `prompt()`, which renders as a system sheet
  // in an installed PWA and can't say any of this.)
  import Modal from '$lib/components/common/Modal.svelte';

  let {
    open,
    busy = false,
    onconfirm,
    oncancel,
  }: {
    open: boolean;
    busy?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  const REQUIRED = 'DELETE';
  let typed = $state('');
  let confirmed = $derived(typed.trim() === REQUIRED);

  // Each opening starts empty, so a dismissed dialog can't leave the word primed
  // for a later, less deliberate click.
  $effect(() => {
    if (open) typed = '';
  });

  function confirm() {
    if (!confirmed || busy) return;
    onconfirm();
  }
</script>

<Modal {open} onclose={oncancel} title="Delete your linkblog?" maxWidth="420px">
  <p class="delete-linkblog-text">
    Every link post will be deleted from your PDS. Your page goes blank and subscribers stop
    receiving it. This cannot be undone.
  </p>
  <label class="delete-linkblog-field">
    <span>Type <strong>{REQUIRED}</strong> to continue</span>
    <input
      type="text"
      bind:value={typed}
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      disabled={busy}
      onkeydown={(e) => {
        if (e.key === 'Enter') confirm();
      }}
    />
  </label>
  {#snippet footer()}
    <button class="btn btn-secondary" onclick={oncancel} disabled={busy}>Cancel</button>
    <button class="btn btn-danger" onclick={confirm} disabled={!confirmed || busy}>
      {busy ? 'Deleting…' : 'Delete linkblog'}
    </button>
  {/snippet}
</Modal>

<style>
  .delete-linkblog-text {
    margin: 0 0 1rem;
    color: var(--color-text);
    line-height: var(--leading-normal);
  }

  .delete-linkblog-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .delete-linkblog-field input {
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-bg);
    color: var(--color-text);
    /* 16px floor: anything smaller triggers Safari iOS auto-zoom on focus. */
    font-size: 1rem;
  }

  .delete-linkblog-field input:focus {
    outline: 2px solid var(--color-primary);
    outline-offset: -1px;
  }
</style>
