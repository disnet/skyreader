<script lang="ts">
  // First-share confirmation: sharing publishes to a public linkblog, which is
  // irreversible-feeling and easy to do by accident. Every surface that can
  // start a share routes through this dialog until the account acknowledges it
  // ("Don't ask again" persists per account) — a share from the reader is as
  // public as one from a card, so neither may skip it.
  //
  // It names the publication the share actually lands in: a connected one, if
  // the user switched, not the Skyreader linkblog they no longer publish to.
  import Modal from '$lib/components/common/Modal.svelte';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { shareDestination } from '$lib/utils/linkblogTargets';

  let {
    open,
    onconfirm,
    oncancel,
    zIndex,
  }: {
    open: boolean;
    onconfirm: () => void;
    oncancel: () => void;
    /** Raise above hosts that themselves float (e.g. the share composer drawer). */
    zIndex?: number;
  } = $props();

  let dontAskAgain = $state(false);
  let target = $derived(shareDestination(myLinkblogStore.publication, myLinkblogStore.publicUrl()));

  // Each opening starts unchecked: a dismissed dialog must not leave the box
  // ticked for the next share the user is only half sure about.
  $effect(() => {
    if (open) dontAskAgain = false;
  });

  function confirm() {
    if (dontAskAgain) preferences.confirmLinkblogShare();
    onconfirm();
  }
</script>

<Modal {open} onclose={oncancel} title="Share to your linkblog?" maxWidth="420px" {zIndex}>
  <p class="share-confirm-text">
    This publishes to {#if target.external}<strong>{target.name}</strong>{:else}your public linkblog{/if}{#if target.address}
      at
      <a href={target.url} target="_blank" rel="noopener noreferrer" class="share-confirm-link"
        >{target.address}</a
      >{/if}. Anyone can read it.
  </p>
  {#if target.external && target.linkblogUrl}
    <p class="share-confirm-aside">
      It shows on
      <a
        href={target.linkblogUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="share-confirm-link">your linkblog page</a
      > too.
    </p>
  {/if}
  <label class="share-confirm-remember">
    <input type="checkbox" bind:checked={dontAskAgain} />
    <span>Don't ask again</span>
  </label>
  {#snippet footer()}
    <button class="btn btn-secondary" onclick={oncancel}>Cancel</button>
    <button class="btn btn-primary" onclick={confirm}>Share</button>
  {/snippet}
</Modal>

<style>
  .share-confirm-text {
    margin: 0 0 1rem;
    color: var(--color-text);
    line-height: var(--leading-normal);
  }

  .share-confirm-aside {
    margin: -0.5rem 0 1rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: var(--leading-normal);
  }

  .share-confirm-link {
    color: var(--color-primary);
    text-decoration: none;
    word-break: break-all;
  }

  .share-confirm-link:hover {
    text-decoration: underline;
  }

  .share-confirm-remember {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .share-confirm-remember input {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }
</style>
