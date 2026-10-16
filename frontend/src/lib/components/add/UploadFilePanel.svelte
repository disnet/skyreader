<script lang="ts">
  import { goto } from '$app/navigation';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { FileUploadError, ScopeUpgradeError } from '$lib/services/api';
  import Icon from '$lib/components/Icon.svelte';
  import { grantPermissions, permissionMessage } from '$lib/services/permissions';
  import type { ScopeFeature } from '$lib/types';
  import { checkUpload, uploadLimitsMb } from '$lib/utils/fileUpload';
  import { SAVED_PATH } from '$lib/utils/viewNav';

  interface Props {
    /** Called once the upload landed, just before the panel navigates to it. */
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  // PDFs and EPUBs from the reader's device (Supporter). A drop anywhere in the
  // app does the same (GlobalFileDrop); this tab is where it's discoverable.
  let canUpload = $derived(Boolean(auth.user?.limits?.pdfSaves));
  let maxMb = $derived(uploadLimitsMb(auth.user?.limits));
  let fileInputEl = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);
  let dragging = $state(false);
  let error = $state<string | null>(null);
  let showScopeUpgrade = $state(false);
  let scopeFeature = $state<ScopeFeature | undefined>(undefined);

  async function uploadFile(file: File) {
    error = null;
    const checked = checkUpload(file, auth.user?.limits);
    if ('error' in checked) {
      error = checked.error;
      return;
    }
    uploading = true;
    try {
      const saved = await savesStore.uploadFile(file, checked.kind);
      // Navigate first, then name the save to open (see SaveLinkPanel).
      onclose();
      await goto(SAVED_PATH);
      savesStore.pendingOpenKey = saved.uri || saved.rkey;
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
    if (!canUpload || uploading || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dragging = true;
  }

  function handleDragLeave(e: DragEvent) {
    // Crossing into a child fires dragleave on the zone; only leaving it counts.
    const to = e.relatedTarget as Node | null;
    if (!to || !(e.currentTarget as HTMLElement).contains(to)) dragging = false;
  }

  function handleDrop(e: DragEvent) {
    dragging = false;
    if (!canUpload) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    // Mark it handled even mid-upload, or GlobalFileDrop starts a second one.
    e.preventDefault();
    if (!uploading) void uploadFile(file);
  }
</script>

{#if showScopeUpgrade}
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
  <!-- A drop anywhere on the panel uploads, even while the zone is busy. -->
  <div
    class="form"
    role="region"
    aria-label="Upload a file"
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
  >
    <p class="modal-desc">
      Upload a PDF or EPUB to keep it on your Shelf, ready to read and highlight.
    </p>
    {#if canUpload}
      <input
        bind:this={fileInputEl}
        type="file"
        accept="application/pdf,.pdf,application/epub+zip,.epub"
        class="file-input"
        onchange={handleFileChange}
        tabindex="-1"
        aria-hidden="true"
      />
      <!-- The whole zone is the picker. -->
      <button
        class="drop-zone"
        class:dragging
        type="button"
        onclick={() => fileInputEl?.click()}
        disabled={uploading}
      >
        <Icon name="file-text" size={22} />
        <span class="drop-title">{uploading ? 'Reading…' : 'Choose a file'}</span>
        <span class="drop-sub">or drop one here</span>
      </button>
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <p class="hint">
        PDFs up to {maxMb.pdf} MB, EPUBs up to {maxMb.epub} MB. Uploads stay private to you. You can also
        drop a file anywhere in Skyreader.
      </p>
    {:else}
      <p class="upsell">
        Saving PDFs and EPUBs is a Supporter feature. Read, highlight, and search them like any
        article.
      </p>
      <a class="upsell-btn" href="/supporter" onclick={onclose}>Become a Supporter</a>
    {/if}
  </div>
{/if}

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .modal-desc {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .file-input {
    display: none;
  }

  .drop-zone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    width: 100%;
    min-height: 120px;
    padding: 1rem;
    border: 1px dashed var(--color-border, #ddd);
    border-radius: 8px;
    background: none;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      border-color 0.15s,
      background-color 0.15s,
      color 0.15s;
  }

  .drop-zone:hover:not(:disabled),
  .drop-zone.dragging {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  .drop-zone.dragging {
    border-style: solid;
    background: var(--color-bg-secondary);
  }

  .drop-zone:focus-visible {
    outline: 2px solid var(--color-primary, #0066cc);
    outline-offset: 2px;
  }

  .drop-zone:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .drop-title {
    margin-top: 0.25rem;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    color: var(--color-text);
  }

  .drop-zone:hover:not(:disabled) .drop-title,
  .drop-zone.dragging .drop-title {
    color: inherit;
  }

  .drop-sub {
    font-size: var(--text-sm);
  }

  .hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-error, #dc2626);
  }

  .upsell {
    margin: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .upsell-btn {
    align-self: flex-start;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    background: var(--color-primary, #0066cc);
    color: white;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    text-decoration: none;
  }

  .upsell-btn:hover {
    opacity: 0.9;
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
</style>
