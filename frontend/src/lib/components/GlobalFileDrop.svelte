<script lang="ts">
  // A PDF or EPUB dropped anywhere in the app saves it (Supporter), and opens it
  // in Saved — the same upload the Add panel's File tab runs. Listens on the
  // window, so no surface has to opt in; a surface with its own drop target
  // (the File tab) handles the drop first and marks it handled.
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { FileUploadError, ScopeUpgradeError } from '$lib/services/api';
  import { permissionToast } from '$lib/services/permissions';
  import { checkUpload } from '$lib/utils/fileUpload';
  import { SAVED_PATH } from '$lib/utils/viewNav';

  let canUpload = $derived(Boolean(auth.user?.limits?.pdfSaves));
  // dragenter/dragleave fire for every element crossed, so count them: the drag
  // has left the window only when the count is back to zero.
  let depth = 0;
  let dragging = $state(false);
  let uploading = false;

  // Only a drag carrying files; dragging text or a link around the page is not
  // a drop of anything to save.
  function carriesFiles(e: DragEvent): boolean {
    return Boolean(auth.user && e.dataTransfer?.types.includes('Files'));
  }

  function handleDragEnter(e: DragEvent) {
    if (!carriesFiles(e)) return;
    depth++;
    dragging = true;
  }

  function handleDragOver(e: DragEvent) {
    if (!carriesFiles(e)) return;
    // Without this the browser opens the file in place of the app.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = canUpload && !uploading ? 'copy' : 'none';
  }

  function handleDragLeave(e: DragEvent) {
    if (!carriesFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) dragging = false;
  }

  function reset() {
    depth = 0;
    dragging = false;
  }

  function handleDrop(e: DragEvent) {
    const handled = e.defaultPrevented;
    const wasFiles = carriesFiles(e);
    reset();
    if (!wasFiles) return;
    e.preventDefault();
    if (handled || uploading) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) void upload(file);
  }

  async function upload(file: File) {
    if (!canUpload) {
      const id = toastStore.add('');
      toastStore.update(id, 'error', 'Supporters can save PDFs and EPUBs.', {
        label: 'Become a Supporter',
        href: '/supporter',
      });
      return;
    }
    const checked = checkUpload(file, auth.user?.limits);
    if ('error' in checked) {
      toastStore.update(toastStore.add(''), 'error', checked.error);
      return;
    }
    uploading = true;
    const id = toastStore.add(`Reading ${file.name}…`);
    try {
      const saved = await savesStore.uploadFile(file, checked.kind);
      toastStore.update(id, 'success', 'Saved');
      sidebarStore.closeAddModal();
      await goto(SAVED_PATH);
      savesStore.pendingOpenKey = saved.uri || saved.rkey;
    } catch (err) {
      if (err instanceof ScopeUpgradeError) {
        const { message, action } = permissionToast(err);
        toastStore.update(id, 'error', message, action);
      } else {
        const message =
          err instanceof FileUploadError || err instanceof Error
            ? err.message
            : "Couldn't upload that file";
        toastStore.update(id, 'error', message);
      }
    } finally {
      uploading = false;
    }
  }
</script>

<svelte:window
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  ondragend={reset}
/>

<!-- The File tab draws its own target while it's open. -->
{#if dragging && sidebarStore.addModalTab !== 'file'}
  <div class="drop-overlay" aria-hidden="true">
    <div class="drop-card">
      {#if canUpload}
        <p class="drop-title">Drop to save</p>
        <p class="drop-sub">A PDF or EPUB, ready to read and highlight.</p>
      {:else}
        <p class="drop-title">Supporters can save PDFs and EPUBs</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(255, 255, 255, 0.85);
    outline: 2px dashed var(--color-primary, #0066cc);
    outline-offset: -12px;
    /* The window's listeners take the drop; the overlay is only a picture. */
    pointer-events: none;
  }

  .drop-card {
    text-align: center;
  }

  .drop-title {
    margin: 0;
    font-size: var(--text-lg, 1.125rem);
    font-weight: var(--weight-medium, 500);
    color: var(--color-text);
  }

  .drop-sub {
    margin: 0.25rem 0 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  @media (prefers-color-scheme: dark) {
    .drop-overlay {
      background: rgba(0, 0, 0, 0.75);
    }
  }
</style>
