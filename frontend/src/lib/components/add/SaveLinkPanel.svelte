<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { FileUploadError, ScopeUpgradeError, UrlSaveLimitError } from '$lib/services/api';
  import Icon from '$lib/components/Icon.svelte';
  import { grantPermissions, permissionMessage } from '$lib/services/permissions';
  import type { ScopeFeature } from '$lib/types';
  import LimitNotice from '$lib/components/LimitNotice.svelte';
  import { saveLimitLine } from '$lib/utils/limitCopy';
  import { checkUpload, uploadLimitsMb } from '$lib/utils/fileUpload';

  interface Props {
    /** Called once the save landed, just before the panel navigates to it. */
    onclose: () => void;
    initialValue?: string;
  }

  let { onclose, initialValue = '' }: Props = $props();

  let urlValue = $state('');
  let error = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let showScopeUpgrade = $state(false);
  let scopeFeature = $state<ScopeFeature | undefined>(undefined);
  // Set when the monthly URL-save cap refuses the save. Held apart from `error`
  // so it renders as a notice with a way forward rather than a red line.
  let limitInfo = $state<{ limit: number; resetsAt: string } | null>(null);

  // PDFs and EPUBs (Supporter): uploaded here, or saved by pasting a link above.
  let canUploadPdf = $derived(Boolean(auth.user?.limits?.pdfSaves));
  let maxMb = $derived(uploadLimitsMb(auth.user?.limits));
  let fileInputEl = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);
  let dragging = $state(false);

  // The panel mounts fresh each time its tab is shown, so state starts clean;
  // just carry over a URL handed in and put the caret in the field.
  onMount(() => {
    urlValue = initialValue;
    requestAnimationFrame(() => inputEl?.focus());
  });

  async function handleSave() {
    const url = urlValue.trim();
    if (!url) return;

    try {
      new URL(url);
    } catch {
      error = 'Please enter a valid URL';
      return;
    }

    error = null;
    limitInfo = null;
    try {
      // A page Skyreader couldn't fetch still saves, as the link plus a note
      // pointing at the extension — so opening it below is right either way.
      const saved = await savesStore.saveFromUrl(url);
      urlValue = '';
      // Take the user to the saved article. Navigate first, THEN signal which
      // item to open: SavedListView opens it via pushState, which must happen
      // after the goto navigation has settled (otherwise the navigation resets
      // page.state and the reader is torn down mid-render → null deref crash).
      await openSaved(saved.uri || saved.itemGuid || saved.rkey);
    } catch (err) {
      if (err instanceof ScopeUpgradeError) {
        scopeFeature = err.feature;
        showScopeUpgrade = true;
      } else if (err instanceof UrlSaveLimitError) {
        limitInfo = { limit: err.limit, resetsAt: err.resetsAt };
      } else {
        error = err instanceof Error ? err.message : 'Failed to save article';
      }
    }
  }

  // Open the save in the reader, the same way a saved link does.
  async function openSaved(key: string) {
    onclose();
    await goto('/saved');
    savesStore.pendingOpenKey = key;
  }

  async function uploadFile(file: File) {
    error = null;
    limitInfo = null;
    const checked = checkUpload(file, auth.user?.limits);
    if ('error' in checked) {
      error = checked.error;
      return;
    }
    uploading = true;
    try {
      const saved = await savesStore.uploadFile(file, checked.kind);
      await openSaved(saved.uri || saved.rkey);
    } catch (err) {
      if (err instanceof ScopeUpgradeError) {
        scopeFeature = err.feature;
        showScopeUpgrade = true;
      } else if (err instanceof FileUploadError) {
        error = err.message;
      } else {
        error = err instanceof Error ? err.message : "Couldn't upload that file";
      }
    } finally {
      uploading = false;
    }
  }

  function handleFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void uploadFile(file);
  }

  function handleDragOver(e: DragEvent) {
    if (!canUploadPdf || uploading || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dragging = true;
  }

  function handleDrop(e: DragEvent) {
    dragging = false;
    if (!canUploadPdf) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    // Mark it handled even mid-upload, or GlobalFileDrop starts a second one.
    e.preventDefault();
    if (!uploading) void uploadFile(file);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  }
</script>

<!-- A PDF or EPUB dropped anywhere on the panel uploads it (Supporter). -->
<div
  class="panel"
  class:dragging
  role="region"
  aria-label="Save a link or file"
  ondragover={handleDragOver}
  ondragleave={() => (dragging = false)}
  ondrop={handleDrop}
>
  {#if limitInfo}
    <div class="limit-wrap">
      <LimitNotice kind="saves">
        <p>{saveLimitLine(limitInfo.limit, limitInfo.resetsAt)}</p>
        <p class="limit-aside">Saving from a feed you subscribe to doesn't count against this.</p>
      </LimitNotice>
    </div>
  {:else if showScopeUpgrade}
    <div class="scope-upgrade">
      <p>{permissionMessage(scopeFeature)} to save this. Then try again.</p>
      <div class="scope-upgrade-actions">
        <button
          class="scope-upgrade-btn"
          type="button"
          onclick={() => grantPermissions(scopeFeature ? [scopeFeature] : [])}
          >{scopeFeature ? 'Allow access' : 'Refresh access'}</button
        >
        <button class="dismiss-btn" onclick={() => (showScopeUpgrade = false)}>Dismiss</button>
      </div>
    </div>
  {:else}
    <div class="form">
      <p class="modal-desc">
        {canUploadPdf
          ? 'Paste a link or upload a PDF or EPUB to keep it in Saved, ready to read and highlight.'
          : 'Paste a link to keep the article in Saved, ready to read.'}
      </p>
      <input
        bind:this={inputEl}
        bind:value={urlValue}
        type="url"
        placeholder="Paste an article URL"
        aria-label="Article URL"
        class="url-input"
        onkeydown={handleKeydown}
        disabled={savesStore.saving || uploading}
      />
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <div class="actions">
        {#if canUploadPdf}
          <input
            bind:this={fileInputEl}
            type="file"
            accept="application/pdf,.pdf,application/epub+zip,.epub"
            class="file-input"
            onchange={handleFileChange}
            tabindex="-1"
            aria-hidden="true"
          />
          <button
            class="upload-btn"
            type="button"
            onclick={() => fileInputEl?.click()}
            disabled={savesStore.saving || uploading}
            title="PDFs up to {maxMb.pdf} MB, EPUBs up to {maxMb.epub} MB. You can also drop one anywhere."
          >
            <Icon name="file-text" size={15} />
            {uploading ? 'Reading…' : 'Upload a file'}
          </button>
        {/if}
        <button
          class="save-btn"
          onclick={handleSave}
          disabled={savesStore.saving || uploading || !urlValue.trim()}
        >
          {#if savesStore.saving && !uploading}
            Saving...
          {:else}
            Save
          {/if}
        </button>
      </div>
      {#if !canUploadPdf && auth.user}
        <p class="pdf-upsell">
          Supporters can save PDFs and EPUBs too, by link or upload, and highlight them like any
          article.
          <a href="/supporter" onclick={onclose}>Become a Supporter</a>
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .limit-wrap {
    padding: 0.25rem 0 0.5rem;
  }

  .limit-aside {
    color: var(--color-text-secondary);
  }

  .modal-desc {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .url-input {
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    font-size: var(--text-md);
    background: var(--color-bg, #fff);
    color: var(--color-text);
    outline: none;
    box-sizing: border-box;
  }

  .url-input:focus {
    border-color: var(--color-primary, #0066cc);
    box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
  }

  .url-input:disabled {
    opacity: 0.6;
  }

  .panel.dragging {
    outline: 2px dashed var(--color-primary, #0066cc);
    outline-offset: 4px;
    border-radius: 6px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .file-input {
    display: none;
  }

  .upload-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-right: auto;
    padding: 0.5rem 0.875rem;
    background: none;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    font-size: var(--text-md);
    color: var(--color-text);
    cursor: pointer;
  }

  .upload-btn:hover:not(:disabled) {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  .upload-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .pdf-upsell {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .pdf-upsell a {
    color: var(--color-primary, #0066cc);
  }

  .save-btn {
    padding: 0.5rem 1.25rem;
    background: var(--color-primary, #0066cc);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .save-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-error, #dc2626);
  }

  .scope-upgrade {
    font-size: var(--text-md);
  }

  .scope-upgrade p {
    margin: 0 0 0.75rem;
  }

  .scope-upgrade-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .scope-upgrade-btn {
    padding: 0.375rem 0.75rem;
    background: var(--color-primary, #0066cc);
    color: white;
    border: none;
    border-radius: 6px;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
    cursor: pointer;
  }

  .dismiss-btn {
    padding: 0.375rem 0.75rem;
    background: none;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 6px;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  @media (max-width: 600px) {
    .url-input {
      font-size: var(--text-base); /* Prevents iOS zoom on focus */
    }
  }
</style>
