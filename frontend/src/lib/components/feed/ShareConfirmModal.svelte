<script lang="ts">
  // First-share confirmation: sharing publishes to a public linkblog, which is
  // irreversible-feeling and easy to do by accident. Every surface that can
  // start a share routes through this dialog until the account acknowledges it
  // ("Don't ask again" persists per account) — a share from the reader is as
  // public as one from a card, so neither may skip it.
  //
  // It names the publication the share actually lands in: a connected one, if
  // the user switched, not the Skyreader linkblog they no longer publish to.
  // And because this is the moment a first-time sharer learns their links get a
  // home at all, it's also where they can choose that home — the Skyreader
  // linkblog, or a publication they already write in — without having to find
  // the setting first. The list is only fetched if they ask for it: a plain
  // Share stays a single click with no PDS round-trip behind it.
  import Modal from '$lib/components/common/Modal.svelte';
  import LinkblogTargetPicker from '$lib/components/settings/LinkblogTargetPicker.svelte';
  import { api } from '$lib/services/api';
  import { myLinkblogStore } from '$lib/stores/myLinkblog.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { shareDestination } from '$lib/utils/linkblogTargets';
  import type { LinkblogPublication, LinkblogPublicationChoice } from '$lib/types';

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

  // ── Destination ─────────────────────────────────────────────────────────────
  let picking = $state(false);
  let loadingChoices = $state(false);
  let choicesError = $state<string | null>(null);
  let choices = $state<LinkblogPublicationChoice[]>([]);
  // Fetched (or connect-returned) publication metadata. The store holds it once
  // the linkblog view has loaded, but a first-time sharer has never opened it.
  let publication = $state<LinkblogPublication | null>(null);
  let selection = $state<{
    uri: string;
    isDefault: boolean;
    format: LinkblogPublication['format'];
    changed: boolean;
    selectable: boolean;
  } | null>(null);
  let applying = $state(false);
  let applyError = $state<string | null>(null);

  let current = $derived(publication ?? myLinkblogStore.publication);
  // The store's public URL is null until it has loaded; `current.url` is always
  // the canonical Skyreader linkblog address, so it stands in.
  let linkblogUrl = $derived(myLinkblogStore.publicUrl() ?? current?.url ?? null);
  let target = $derived(shareDestination(current, linkblogUrl));
  // What the Share button is about to switch them to, named the way the picker
  // named it — the sentence above still describes where links go *today*.
  let pendingName = $derived(
    selection?.changed
      ? selection.isDefault
        ? 'your Skyreader linkblog'
        : (choices.find((choice) => choice.uri === selection?.uri)?.name ?? 'that publication')
      : null
  );

  // Each opening starts unchecked and collapsed: a dismissed dialog must not
  // leave the box ticked for the next share the user is only half sure about,
  // nor reopen mid-decision on a destination they walked away from.
  $effect(() => {
    if (open) {
      dontAskAgain = false;
      picking = false;
      selection = null;
      applyError = null;
    }
  });

  async function openPicker() {
    picking = true;
    if (choices.length > 0) return;
    loadingChoices = true;
    choicesError = null;
    try {
      const [pub, list] = await Promise.all([
        current ? Promise.resolve(current) : api.getLinkblogPublication(),
        api.listLinkblogPublications(),
      ]);
      publication = pub;
      choices = list.publications;
    } catch {
      choicesError = 'Could not load your publications. You can also change this in Settings.';
    } finally {
      loadingChoices = false;
    }
  }

  async function confirm() {
    if (applying) return;
    // A destination change is applied before the share, so this link is the
    // first thing in its new home rather than the last thing in the old one.
    if (selection?.changed && selection.selectable) {
      applying = true;
      applyError = null;
      try {
        const next = selection.isDefault
          ? await api.disconnectLinkblogPublication()
          : await api.connectLinkblogPublication(selection.uri, selection.format);
        publication = next;
        // "Publishing here" and the post counts are now stale.
        choices = [];
        selection = null;
        picking = false;
        // Settle the store before the share writes its optimistic entry into it.
        await myLinkblogStore.load(true);
      } catch (error) {
        applyError =
          error instanceof Error ? error.message : 'Could not change where your links publish.';
        return;
      } finally {
        applying = false;
      }
    }
    if (dontAskAgain) preferences.confirmLinkblogShare();
    onconfirm();
  }
</script>

<Modal
  {open}
  onclose={oncancel}
  title="Share to your linkblog?"
  maxWidth={picking ? '520px' : '420px'}
  {zIndex}
>
  <p class="share-confirm-text">
    This publishes to {#if target.external}<strong>{target.name}</strong>{:else}your public linkblog{/if}{#if target.address}{' '}at
      <a href={target.url} target="_blank" rel="noopener noreferrer" class="share-confirm-link"
        >{target.address}</a
      >{/if}.
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

  {#if !picking}
    <button type="button" class="share-confirm-change" onclick={openPicker}>
      Publish somewhere else
    </button>
  {:else if loadingChoices}
    <p class="share-confirm-aside">Loading your publications…</p>
  {:else if choicesError}
    <p class="share-confirm-error">{choicesError}</p>
  {:else if current && choices.length > 0}
    <LinkblogTargetPicker
      {current}
      {choices}
      busy={applying}
      showActions={false}
      onselect={(next) => (selection = next)}
    />
    {#if pendingName}
      <p class="share-confirm-aside">
        Sharing moves your linkblog to <strong>{pendingName}</strong>. Links already published stay
        where they are.
      </p>
    {/if}
  {/if}

  {#if applyError}
    <p class="share-confirm-error">{applyError}</p>
  {/if}

  <label class="share-confirm-remember">
    <input type="checkbox" bind:checked={dontAskAgain} />
    <span>Don't ask again</span>
  </label>
  {#snippet footer()}
    <button class="btn btn-secondary" onclick={oncancel} disabled={applying}>Cancel</button>
    <button class="btn btn-primary" onclick={confirm} disabled={applying}>
      {applying ? 'Connecting…' : 'Share'}
    </button>
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

  .share-confirm-aside strong {
    color: var(--color-text);
    font-weight: var(--weight-medium);
  }

  .share-confirm-error {
    margin: 0 0 1rem;
    font-size: var(--text-sm);
    color: var(--color-error);
    line-height: var(--leading-normal);
  }

  /* A quiet way out of the default, not a second call to action: the dialog is
     here to confirm a share, and most people just want the Share button. */
  .share-confirm-change {
    display: inline-block;
    margin: -0.5rem 0 1rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--color-primary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .share-confirm-change:hover {
    text-decoration: underline;
  }

  .share-confirm-change:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
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
