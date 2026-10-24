<script lang="ts">
  import Modal from '$lib/components/common/Modal.svelte';
  import { api } from '$lib/services/api';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import {
    IMPORT_SOURCE_NAMES,
    parseExportFiles,
    type ImportedSave,
    type ImportSource,
  } from '$lib/utils/readLaterImport/parsers';
  import { runImport, type ImportTotals } from '$lib/utils/readLaterImport/run';
  import { docsUrl } from '$lib/constants/docs';
  import { copySavesToBacking } from '$lib/utils/backingExport';
  import type { SaveBacking } from '$lib/types';

  interface Props {
    open: boolean;
    onclose: () => void;
    /** With Semble or Margin backing, imports are copied into that public collection too. */
    backing: SaveBacking;
  }

  let { open, onclose, backing }: Props = $props();

  const backedBy = $derived(
    backing.provider === 'semble' ? 'Semble' : backing.provider === 'margin' ? 'Margin' : null
  );

  type Step = 'select' | 'reading' | 'preview' | 'importing' | 'copying' | 'complete';
  let step = $state<Step>('select');
  let saves = $state.raw<ImportedSave[]>([]);
  let warnings = $state<string[]>([]);
  let progress = $state({ done: 0, total: 0 });
  let totals = $state<ImportTotals | null>(null);
  let copied = $state<number | null>(null);
  let error = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();

  const summary = $derived.by(() => {
    const sources = new Set<ImportSource>();
    let archived = 0;
    let highlights = 0;
    const tags = new Set<string>();
    for (const save of saves) {
      sources.add(save.source);
      if (save.archived) archived++;
      highlights += save.highlights.length;
      for (const tag of save.tags) tags.add(tag);
    }
    return {
      from: [...sources].map((s) => IMPORT_SOURCE_NAMES[s]).join(' and '),
      sources: sources.size,
      archived,
      highlights,
      tags: tags.size,
    };
  });

  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`;

  function reset() {
    step = 'select';
    saves = [];
    warnings = [];
    progress = { done: 0, total: 0 };
    totals = null;
    copied = null;
    error = null;
    if (fileInput) fileInput.value = '';
  }

  function handleClose() {
    // An import in flight keeps going until it's done; closing mid-way would
    // leave the reader not knowing how much of it landed.
    if (step === 'importing' || step === 'copying') return;
    reset();
    onclose();
  }

  async function handleFiles(e: Event) {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    if (files.length === 0) return;
    step = 'reading';
    error = null;
    try {
      const parsed = await parseExportFiles(
        await Promise.all(
          files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))
        )
      );
      saves = parsed.saves;
      warnings = parsed.warnings;
      step = parsed.saves.length > 0 ? 'preview' : 'select';
      if (parsed.saves.length === 0) {
        error = 'No saved articles found in that file. Choose the export your app sent you.';
      }
    } catch (err) {
      step = 'select';
      error = `Couldn't read that file: ${(err as Error).message}`;
    }
  }

  async function startImport() {
    step = 'importing';
    error = null;
    try {
      totals = await runImport(
        saves,
        (source, items) => api.importSaved(source, items),
        (done, total) => (progress = { done, total })
      );
    } catch (err) {
      totals = (err as { totals?: ImportTotals }).totals ?? null;
      error = `The import stopped partway: ${(err as Error).message}. Importing the same file again picks up where it left off.`;
    }
    if (backedBy && totals && totals.rkeys.length > 0) {
      // The Library is the backing collection, so what was just added goes
      // into it too, as the reader was warned. Only this import's new saves:
      // nothing else the reader kept private.
      step = 'copying';
      progress = { done: 0, total: 0 };
      try {
        copied = await copySavesToBacking((done, total) => (progress = { done, total }), {
          rkeys: totals.rkeys,
        });
      } catch (err) {
        error = `Some imported articles weren't added to your ${backedBy} collection: ${(err as Error).message}. They're still in your Library here.`;
      }
    }
    step = 'complete';
    // Bring the new saves and their labels into this device now rather than at
    // the next refresh.
    await Promise.allSettled([
      savesStore.load(),
      itemLabelsStore.pullDelta(),
      shelfStore.load(true),
    ]);
  }

  $effect(() => {
    if (!open) reset();
  });
</script>

<Modal {open} onclose={handleClose} title="Import saves" icon="arrow-down" maxWidth="520px">
  {#if step === 'select' || step === 'reading'}
    <p class="description">
      Bring your saved articles, tags, archive and highlights from Pocket, Omnivore, Instapaper,
      Readwise Reader or Matter. Choose the export file (a zip is fine), or several files at once.
      <a href={docsUrl('importLibrary')} target="_blank" rel="noopener noreferrer"
        >Where to find your export</a
      >
    </p>
    <input
      bind:this={fileInput}
      type="file"
      multiple
      accept=".zip,.csv,.json,.html,.htm,.md"
      onchange={handleFiles}
      disabled={step === 'reading'}
      class="file-input"
    />
    {#if step === 'reading'}
      <p class="muted">Reading…</p>
    {/if}
    {#if error}
      <p class="error">{error}</p>
    {/if}
    {#each warnings as warning}
      <p class="muted">{warning}</p>
    {/each}
  {:else if step === 'preview'}
    {#if backedBy}
      <p class="public-warning" role="note">
        Your saves are backed by {backedBy}, so every imported article is also added to your
        {backedBy} collection, which is <strong>public</strong>: anyone can see what's in it.
      </p>
    {/if}
    <p>
      Found {plural(saves.length, 'article')} from {summary.from}{summary.archived > 0
        ? `, ${summary.archived.toLocaleString()} of them archived`
        : ''}.
    </p>
    <ul class="facts">
      {#if summary.tags > 0}
        <li>{plural(summary.tags, 'tag')}, kept as tags</li>
      {/if}
      {#if summary.highlights > 0}
        <li>{plural(summary.highlights, 'highlight')}, attached to their articles</li>
      {/if}
      <li>
        {summary.sources === 1
          ? `They all go in a Shelf collection, “Imported from ${summary.from}”.`
          : 'They go in a Shelf collection for each app, named “Imported from” the app.'}
      </li>
      <li>Articles already in your Library are otherwise left as they are.</li>
      <li>Each article's text is fetched the first time you open it.</li>
    </ul>
    {#each warnings as warning}
      <p class="muted">{warning}</p>
    {/each}
  {:else if step === 'importing' || step === 'copying'}
    <p>{step === 'importing' ? 'Importing…' : `Adding to your ${backedBy} collection…`}</p>
    <div
      class="progress-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
    >
      <div
        class="progress-fill"
        style="width: {progress.total ? (progress.done / progress.total) * 100 : 0}%"
      ></div>
    </div>
    <p class="progress-text">
      {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
    </p>
  {:else if step === 'complete'}
    {#if totals}
      <dl class="results">
        <dt>Added to your Library</dt>
        <dd>{totals.added.toLocaleString()}</dd>
        {#if totals.duplicates > 0}
          <dt>Already saved</dt>
          <dd>{totals.duplicates.toLocaleString()}</dd>
        {/if}
        {#if totals.highlights > 0}
          <dt>Highlights</dt>
          <dd>{totals.highlights.toLocaleString()}</dd>
        {/if}
        {#if copied !== null}
          <dt>Added to your {backedBy} collection</dt>
          <dd>{copied.toLocaleString()}</dd>
        {/if}
        {#if totals.invalid > 0}
          <dt>Skipped (no web address)</dt>
          <dd>{totals.invalid.toLocaleString()}</dd>
        {/if}
      </dl>
    {/if}
    {#if error}
      <p class="error">{error}</p>
    {/if}
  {/if}

  {#snippet footer()}
    {#if step === 'preview'}
      <button class="btn btn-secondary" onclick={reset}>Back</button>
      <button class="btn btn-primary" onclick={startImport}>
        Import {plural(saves.length, 'article')}
      </button>
    {:else if step === 'complete'}
      <button class="btn btn-primary" onclick={handleClose}>Done</button>
    {/if}
  {/snippet}
</Modal>

<style>
  .description {
    color: var(--color-text-secondary);
    margin: 0 0 1rem;
  }

  .file-input {
    width: 100%;
    padding: 0.75rem;
    border: 2px dashed var(--color-border);
    border-radius: 4px;
    cursor: pointer;
  }

  .file-input:hover {
    border-color: var(--color-primary);
  }

  .muted {
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .error {
    color: var(--color-error);
    font-size: var(--text-md);
  }

  .facts {
    margin: 0.5rem 0 0;
    padding-left: 1.25rem;
    color: var(--color-text-secondary);
  }

  .public-warning {
    margin: 0 0 1rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-warning-border, #ffc107);
    border-radius: 6px;
    background: var(--color-warning-bg, #fff3cd);
    color: var(--color-warning-text, #856404);
  }

  .facts li + li {
    margin-top: 0.25rem;
  }

  .progress-bar {
    height: 8px;
    background: var(--color-border);
    border-radius: 4px;
    overflow: hidden;
    margin: 1rem 0;
  }

  .progress-fill {
    height: 100%;
    background: var(--color-primary);
    transition: width 0.2s ease;
  }

  .progress-text {
    text-align: center;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  .results {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.5rem 1rem;
    margin: 0 0 1rem;
  }

  .results dt {
    color: var(--color-text-secondary);
  }

  .results dd {
    margin: 0;
    font-weight: var(--weight-medium);
    text-align: right;
  }
</style>
