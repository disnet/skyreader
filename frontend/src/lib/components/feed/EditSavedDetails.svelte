<script lang="ts">
  // "Edit details" for one save: its title, author, date and summary, mounted
  // once in AppShell and driven by savesStore.editing, so every surface that
  // holds a save (the reader, the Saved list, the Shelf) can offer it. Only the
  // fields the reader changed are sent, and the server keeps those over any
  // later re-extraction of the same save.
  import Modal from '$lib/components/common/Modal.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';
  import { decodeEntities } from '$lib/utils/entities';
  import type { SavedItem, SavedMetadataEdit } from '$lib/types';

  let save = $derived(savesStore.editing);

  let title = $state('');
  let author = $state('');
  let published = $state('');
  let description = $state('');
  let initial = { title: '', author: '', published: '', description: '' };
  let saving = $state(false);
  let error = $state<string | null>(null);

  // A date the reader picks is stored at midday UTC (see changes()), so it's
  // read back by its UTC day: that round-trips in every timezone.
  function toDateInput(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  // The page's shortcuts stand down while this is up, so a key pressed before a
  // field has focus (s, e) can't unsave or archive the save being edited.
  let isOpen = $derived(save !== null);
  let titleInput = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (!isOpen) return;
    const release = keyboardStore.suspend();
    queueMicrotask(() => titleInput?.focus());
    return release;
  });

  // Fill the form once per save opened, not on every change to the row (which
  // would wipe what's being typed when a sync lands).
  let filledFor: string | null = null;
  $effect(() => {
    if (!save) {
      filledFor = null;
      return;
    }
    if (filledFor === save.rkey) return;
    filledFor = save.rkey;
    initial = {
      title: decodeEntities(save.title) || '',
      author: decodeEntities(save.author),
      published: toDateInput(save.publishedAt),
      description: decodeEntities(save.description),
    };
    ({ title, author, published, description } = initial);
    error = null;
  });

  let isBook = $derived(save?.contentType === 'pdf' || save?.contentType === 'epub');

  function changes(): SavedMetadataEdit {
    const edit: SavedMetadataEdit = {};
    if (title.trim() !== initial.title.trim()) edit.title = title.trim();
    if (author.trim() !== initial.author.trim()) edit.author = author.trim() || null;
    if (description.trim() !== initial.description.trim()) {
      edit.description = description.trim() || null;
    }
    // Midday UTC, so the day survives being shown in any timezone.
    if (published !== initial.published) {
      edit.publishedAt = published ? `${published}T12:00:00.000Z` : null;
    }
    return edit;
  }

  function close() {
    saving = false;
    savesStore.closeEditor();
  }

  async function submit(e: SubmitEvent, target: SavedItem) {
    e.preventDefault();
    if (saving) return;
    if (!title.trim()) {
      error = 'A title is needed.';
      return;
    }
    const edit = changes();
    if (Object.keys(edit).length === 0) return close();
    saving = true;
    error = null;
    try {
      await savesStore.editMetadata(target.rkey, edit);
      close();
    } catch (err) {
      error = err instanceof Error && err.message ? err.message : 'Couldn’t save the changes.';
      saving = false;
    }
  }
</script>

<Modal open={save !== null} onclose={close} title="Edit details" icon="edit" maxWidth="460px">
  {#if save}
    {@const target = save}
    <form class="form" onsubmit={(e) => submit(e, target)}>
      <label class="field">
        <span class="label">Title</span>
        <input type="text" bind:this={titleInput} bind:value={title} required maxlength="500" />
      </label>

      <label class="field">
        <span class="label">{isBook ? 'Authors' : 'Author'}</span>
        <input type="text" bind:value={author} maxlength="500" />
        <span class="hint">Separate several with a semicolon.</span>
      </label>

      <label class="field">
        <span class="label">Published</span>
        <input type="date" bind:value={published} />
      </label>

      <label class="field">
        <span class="label">Summary</span>
        <textarea rows="3" bind:value={description}></textarea>
      </label>

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <div class="buttons">
        <button type="button" class="btn-secondary" onclick={close} disabled={saving}>
          Cancel
        </button>
        <button type="submit" class="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  {/if}
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .label {
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  input,
  textarea {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font: inherit;
    font-size: var(--text-md);
    background: var(--color-bg);
    color: var(--color-text);
  }

  textarea {
    resize: vertical;
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    input,
    textarea {
      font-size: 1rem;
    }
  }

  input:focus,
  textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .error {
    margin: 0;
    color: var(--color-error);
    font-size: var(--text-md);
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 0.25rem;
  }

  .btn-primary,
  .btn-secondary {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .btn-primary {
    background: var(--color-primary);
    color: white;
    border: none;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--color-primary-dark, #0056b3);
  }

  .btn-secondary {
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .btn-primary:disabled,
  .btn-secondary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
