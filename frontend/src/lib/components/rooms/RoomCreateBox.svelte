<script lang="ts">
  // Starting a room from the /rooms index. A room is a collection, so this
  // creates one — in the reader's own repo, on Semble by default — and joins it
  // in the same request; the page then opens the new room.
  //
  // Folded away until asked for: the index is a list of places to read, and a
  // form standing open above it would make every visit look like a setup step.
  // The open/closed choice is Semble's own access rule (who may add articles),
  // read back by the room page's add box, so what is chosen here is what the
  // room enforces. Margin has no such rule: a Margin room is owner-only.
  import Icon from '$lib/components/Icon.svelte';
  import { api, ScopeUpgradeError } from '$lib/services/api';
  import { collectionsStore } from '$lib/stores/collections.svelte';
  import { roomsStore } from '$lib/stores/rooms.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  interface Props {
    onCreated: (uri: string) => void;
  }

  let { onCreated }: Props = $props();

  type Provider = 'semble' | 'margin';
  type Access = 'open' | 'closed';

  const NAME_MAX = 120;
  const DESCRIPTION_MAX = 500;

  let open = $state(false);
  let name = $state('');
  let description = $state('');
  let provider = $state<Provider>('semble');
  let access = $state<Access>('closed');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let nameEl = $state<HTMLInputElement | null>(null);

  const trimmedName = $derived(name.trim());
  const providerLabel = $derived(provider === 'semble' ? 'Semble' : 'Margin');

  function show() {
    open = true;
    error = null;
    // The field is what the click was for; the disclosure itself is chrome.
    queueMicrotask(() => nameEl?.focus());
  }

  function hide() {
    if (busy) return;
    open = false;
    error = null;
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (!trimmedName) {
      error = 'Give the room a name.';
      nameEl?.focus();
      return;
    }
    busy = true;
    error = null;
    try {
      const created = await api.createRoom({
        name: trimmedName,
        description: provider === 'semble' ? description.trim() : undefined,
        provider,
        access: provider === 'semble' ? access : undefined,
      });
      // The new collection belongs in the open box's list and on Home's lanes
      // without waiting for either cache to age out.
      void collectionsStore.invalidate(provider);
      void roomsStore.refresh();
      if (!created.joined) {
        toastStore.update(
          toastStore.add('Room created. Joining did not go through; try Join on the room.'),
          'error'
        );
      }
      name = '';
      description = '';
      open = false;
      onCreated(created.uri);
    } catch (err) {
      error =
        err instanceof ScopeUpgradeError
          ? `Log in again to grant ${providerLabel} permissions, then create the room.`
          : 'Could not create the room.';
    } finally {
      busy = false;
    }
  }
</script>

{#if !open}
  <button class="room-create-toggle" type="button" onclick={show}>
    <Icon name="plus" size={16} />
    Start a new room
  </button>
{:else}
  <form class="room-create" onsubmit={create} aria-label="Start a new room">
    <div class="room-create-head">
      <h2>New room</h2>
      <button
        class="room-create-close"
        type="button"
        onclick={hide}
        disabled={busy}
        title="Cancel"
        aria-label="Cancel"
      >
        <Icon name="x" size={14} />
      </button>
    </div>

    <label class="room-create-field">
      <span class="room-create-label">Name</span>
      <input
        class="input"
        type="text"
        bind:value={name}
        bind:this={nameEl}
        maxlength={NAME_MAX}
        placeholder="What the room is reading"
        autocomplete="off"
        disabled={busy}
        required
        oninput={() => (error = null)}
      />
    </label>

    {#if provider === 'semble'}
      <label class="room-create-field">
        <span class="room-create-label"
          >Description <span class="room-create-optional">optional</span></span
        >
        <textarea
          class="input room-create-textarea"
          bind:value={description}
          maxlength={DESCRIPTION_MAX}
          rows="2"
          placeholder="A line about the room, for people deciding whether to read along"
          disabled={busy}></textarea>
      </label>
    {/if}

    <fieldset class="room-create-group" disabled={busy}>
      <legend class="room-create-label">Lives on</legend>
      <div class="room-create-options">
        <label class="room-create-option" class:selected={provider === 'semble'}>
          <input type="radio" name="room-provider" value="semble" bind:group={provider} />
          <span class="room-create-radio" aria-hidden="true"></span>
          <span class="room-create-option-text">
            <span class="room-create-option-title">Semble</span>
            <span class="room-create-option-meta">A Semble collection.</span>
          </span>
        </label>
        <label class="room-create-option" class:selected={provider === 'margin'}>
          <input type="radio" name="room-provider" value="margin" bind:group={provider} />
          <span class="room-create-radio" aria-hidden="true"></span>
          <span class="room-create-option-text">
            <span class="room-create-option-title">Margin</span>
            <span class="room-create-option-meta">A Margin collection. </span>
          </span>
        </label>
      </div>
    </fieldset>

    {#if provider === 'semble'}
      <fieldset class="room-create-group" disabled={busy}>
        <legend class="room-create-label">Who can add articles</legend>
        <div class="room-create-options">
          <label class="room-create-option" class:selected={access === 'closed'}>
            <input type="radio" name="room-access" value="closed" bind:group={access} />
            <span class="room-create-radio" aria-hidden="true"></span>
            <span class="room-create-option-text">
              <span class="room-create-option-title">Closed</span>
              <span class="room-create-option-meta"
                >Only you can add articles. Anyone can still read along.</span
              >
            </span>
          </label>
          <label class="room-create-option" class:selected={access === 'open'}>
            <input type="radio" name="room-access" value="open" bind:group={access} />
            <span class="room-create-radio" aria-hidden="true"></span>
            <span class="room-create-option-text">
              <span class="room-create-option-title">Open</span>
              <span class="room-create-option-meta">Anyone can add articles.</span>
            </span>
          </label>
        </div>
      </fieldset>
    {/if}

    <p class="room-create-note">
      The room is public: the collection is stored in your own repo on the Atmosphere.
    </p>

    {#if error}
      <p class="room-create-error" role="alert">{error}</p>
    {/if}

    <div class="room-create-actions">
      <button class="btn btn-secondary" type="button" onclick={hide} disabled={busy}>Cancel</button>
      <button class="btn btn-primary" type="submit" disabled={busy || !trimmedName}>
        {busy ? 'Creating…' : 'Create room'}
      </button>
    </div>
  </form>
{/if}

<style>
  .room-create-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin: -0.75rem 0 0.5rem;
    padding: 0.25rem 0;
    border: none;
    background: none;
    color: var(--color-primary);
    font-size: var(--text-md);
    cursor: pointer;
  }

  .room-create-toggle:hover {
    text-decoration: underline;
  }

  .room-create {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    margin: -0.75rem 0 1.5rem;
    padding: 0.875rem 1rem 1rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-secondary);
  }

  .room-create-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .room-create-head h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug);
  }

  .room-create-close {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .room-create-close:hover:not(:disabled) {
    background: var(--color-border);
    color: var(--color-text);
  }

  .room-create-field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .room-create-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
  }

  .room-create-optional {
    font-weight: normal;
  }

  .room-create-textarea {
    resize: vertical;
    min-height: 2.5rem;
    line-height: 1.4;
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px,
     and it never zooms back out. */
  @media (hover: none) and (pointer: coarse) {
    .room-create input,
    .room-create textarea {
      font-size: var(--text-base);
    }
  }

  .room-create-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    border: none;
    min-width: 0;
  }

  .room-create-group legend {
    padding: 0;
    margin-bottom: 0.375rem;
  }

  .room-create-options {
    display: flex;
    gap: 0.5rem;
  }

  .room-create-option {
    position: relative;
    flex: 1;
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.5rem 0.625rem;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    cursor: pointer;
  }

  .room-create-option:hover {
    border-color: var(--color-primary);
  }

  .room-create-option.selected {
    border-color: var(--color-primary);
  }

  /* Native radio stays present for keyboard + group semantics, visually hidden
     in favor of the custom dot. */
  .room-create-option input[type='radio'] {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }

  .room-create-option:has(input:focus-visible) {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .room-create-radio {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    margin-top: 0.125rem;
    border: 1.5px solid var(--color-border);
    border-radius: 50%;
  }

  .room-create-radio::after {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-primary);
    transform: scale(0);
    transition: transform 0.15s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .room-create-option.selected .room-create-radio {
    border-color: var(--color-primary);
  }

  .room-create-option.selected .room-create-radio::after {
    transform: scale(1);
  }

  .room-create-option-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .room-create-option-title {
    font-size: var(--text-md);
    color: var(--color-text);
  }

  .room-create-option-meta {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: 1.35;
  }

  .room-create-note {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.4;
    color: var(--color-text-secondary);
  }

  .room-create-error {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-error);
  }

  .room-create-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  @media (max-width: 480px) {
    .room-create-options {
      flex-direction: column;
    }
  }
</style>
