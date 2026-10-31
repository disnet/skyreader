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
  import { bookKey } from '$lib/utils/readLaterImport/books';
  import {
    importOrder,
    placeInQueue,
    runImport,
    type ImportTotals,
    type QueuePlacement,
  } from '$lib/utils/readLaterImport/run';
  import { docsUrl } from '$lib/constants/docs';
  import { domainFromUrl } from '$lib/utils/highlightSource';
  import type { SaveBacking } from '$lib/types';
  import { integrationLabel } from '$lib/types';

  interface Props {
    open: boolean;
    onclose: () => void;
    /** With Semble or Margin backing, imports are copied into that public collection too. */
    backing: SaveBacking;
  }

  let { open, onclose, backing }: Props = $props();

  const backedBy = $derived(
    backing.provider === 'skyreader' ? null : integrationLabel(backing.provider)
  );

  /** Rows of the article list drawn at a time. */
  const LIST_PAGE = 200;

  type Step = 'select' | 'reading' | 'preview' | 'importing' | 'complete';
  let step = $state<Step>('select');
  let saves = $state.raw<ImportedSave[]>([]);
  let warnings = $state<string[]>([]);
  let progress = $state({ done: 0, total: 0 });
  let totals = $state<ImportTotals | null>(null);
  // The reader paused their background copy, so these saves wait for Resume.
  let copyPaused = $state(false);
  let error = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();
  // Which articles go, by their index in `ordered`: all of them unless unticked.
  // Replaced whole on every change: one signal, so unticking a library of
  // thousands doesn't subscribe to (or notify) each index.
  let skipped = $state.raw(new Set<number>());
  let placement = $state<QueuePlacement>('as-exported');
  let fileOnShelf = $state(true);
  // Rows drawn so far: a big library is thousands, drawn a page at a time.
  let shown = $state(LIST_PAGE);

  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`;

  // The order they're imported in (unread, newest first, then the archive).
  const ordered = $derived(importOrder(saves));
  const chosen = $derived(ordered.filter((_, i) => !skipped.has(i)));
  const chosenBooks = $derived(chosen.reduce((n, s) => n + (s.kind === 'book' ? 1 : 0), 0));
  // Books already in the Library, by title and author as the server matches them.
  const savedBooks = $derived(
    new Set(
      savesStore.articles
        .filter((a) => a.contentType === 'book' && !a.url)
        .map((a) => bookKey(a.title, a.author))
    )
  );
  // Articles already in the Library, matched the way the rest of the app
  // matches a link to a save (exactly, else by canonical URL). The server makes
  // the final call; this is so the reader knows before choosing.
  const alreadySaved = $derived(
    new Set(
      ordered.flatMap((save, i) =>
        (
          save.kind === 'book'
            ? savedBooks.has(bookKey(save.title, save.author))
            : savesStore.getByUrl(save.url)
        )
          ? [i]
          : []
      )
    )
  );
  const bookCount = $derived(saves.reduce((n, s) => n + (s.kind === 'book' ? 1 : 0), 0));
  /** "3 articles", "12 books", or "3 articles and 12 books". */
  const things = (articles: number, books: number) =>
    [
      articles > 0 || books === 0 ? plural(articles, 'article') : '',
      books > 0 ? plural(books, 'book') : '',
    ]
      .filter(Boolean)
      .join(' and ');
  const alreadySavedChosen = $derived([...alreadySaved].filter((i) => !skipped.has(i)).length);
  // The server never changes an existing save's archive state or tags. A book
  // already saved gains only the highlights it hasn't had before.
  const keptNote = $derived(
    `${plural(alreadySavedChosen, bookCount === saves.length ? 'book' : 'article')} already in your Library ` +
      (alreadySavedChosen === 1 ? 'keeps its place and tags' : 'keep their place and tags') +
      (bookCount > 0 ? ', and books gain only highlights that are new.' : '.')
  );

  // The file as a whole, for which placements to offer.
  const file = $derived.by(() => {
    const sources = new Set<ImportSource>();
    let archived = 0;
    // Books come in archived (kept on the Shelf), so they aren't counted as the
    // reader's archive from the other app.
    let archivedArticles = 0;
    for (const save of saves) {
      sources.add(save.source);
      if (save.archived) archived++;
      if (save.archived && save.kind !== 'book') archivedArticles++;
    }
    return {
      from: [...sources].map((s) => IMPORT_SOURCE_NAMES[s]).join(' and '),
      sources: sources.size,
      archived,
      archivedArticles,
      mixed: archived > 0 && archived < saves.length,
    };
  });

  /** The list, one group per app when the export came from more than one. */
  const groups = $derived.by(() => {
    const bySource = new Map<ImportSource, number[]>();
    ordered.forEach((save, i) => {
      const group = bySource.get(save.source);
      if (group) group.push(i);
      else bySource.set(save.source, [i]);
    });
    let budget = shown;
    return [...bySource].map(([source, indices]) => {
      const visible = indices.slice(0, Math.max(0, budget));
      budget -= visible.length;
      const picked = indices.reduce((n, i) => n + (skipped.has(i) ? 0 : 1), 0);
      return { source, indices, visible, picked };
    });
  });
  const hidden = $derived(ordered.length - groups.reduce((n, g) => n + g.visible.length, 0));

  function setPicked(indices: number[], picked: boolean) {
    const next = new Set(skipped);
    for (const i of indices) {
      if (picked) next.delete(i);
      else next.add(i);
    }
    skipped = next;
  }

  function toggle(i: number) {
    setPicked([i], skipped.has(i));
  }

  const summary = $derived.by(() => {
    let highlights = 0;
    let shortlist = 0;
    const tags = new Set<string>();
    ordered.forEach((save, i) => {
      // Saves already in the Library don't take the export's tags, and their
      // highlights only sometimes, so they're left out of these counts.
      if (skipped.has(i) || alreadySaved.has(i)) return;
      highlights += save.highlights.length;
      // Readwise Reader's Shortlist comes across as a tag, said on a line of its own.
      if (save.shortlisted) shortlist++;
      for (const tag of save.tags) if (!(save.shortlisted && tag === 'shortlist')) tags.add(tag);
    });
    return { highlights, shortlist, tags: tags.size };
  });

  function reset() {
    step = 'select';
    saves = [];
    skipped = new Set();
    placement = 'as-exported';
    fileOnShelf = true;
    shown = LIST_PAGE;
    warnings = [];
    progress = { done: 0, total: 0 };
    totals = null;
    copyPaused = false;
    error = null;
    if (fileInput) fileInput.value = '';
  }

  function handleClose() {
    // An import in flight keeps going until it's done; closing mid-way would
    // leave the reader not knowing how much of it landed.
    if (step === 'importing') return;
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
      skipped = new Set();
      shown = LIST_PAGE;
      // What happens today stays the default: each article where it was. When
      // the file is all unread or all archived, that's the Inbox or the Archive.
      placement = file.mixed ? 'as-exported' : file.archived > 0 ? 'archive' : 'inbox';
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
        placeInQueue(chosen, placement),
        (source, items) =>
          api.importSaved(source, items, fileOnShelf).then((r) => {
            if (r.copyPaused) copyPaused = true;
            return r;
          }),
        (done, total) => (progress = { done, total })
      );
    } catch (err) {
      totals = (err as { totals?: ImportTotals }).totals ?? null;
      error = `The import stopped partway: ${(err as Error).message}. Importing the same file again, with the same articles and choices, picks up where it left off.`;
    }
    // With backing on, the server copies this import's new saves into the
    // collection in the background (api.importSaved asks it to), as the reader
    // was warned. Only these: nothing else the reader kept private.
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

<Modal {open} onclose={handleClose} title="Import saves" icon="arrow-down" maxWidth="560px">
  {#if step === 'select' || step === 'reading'}
    <p class="description">
      Bring your saved articles, tags, archive and highlights from Pocket, Omnivore, Instapaper,
      Readwise Reader, Matter or Wallabag, and your book highlights from Kindle (My Clippings.txt)
      or Readwise. Choose the export file (a zip is fine), or several files at once.
      <a href={docsUrl('importLibrary')} target="_blank" rel="noopener noreferrer"
        >Where to find your export</a
      >
    </p>
    <input
      bind:this={fileInput}
      type="file"
      multiple
      accept=".zip,.csv,.json,.html,.htm,.md,.txt"
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
        {#if bookCount > 0}
          Books have no web address, so they stay private to Skyreader.
        {/if}
      </p>
    {/if}
    <p class="found">
      Found {things(saves.length - bookCount, bookCount)} from {file.from}{file.archivedArticles > 0
        ? `, ${bookCount > 0 ? plural(file.archivedArticles, 'article') : `${file.archivedArticles.toLocaleString()} of them`} archived`
        : ''}{alreadySaved.size > 0
        ? `, ${alreadySaved.size.toLocaleString()} already in your Library`
        : ''}. Untick any you'd rather leave behind.
      {#if alreadySavedChosen > 0}
        <button
          type="button"
          class="link-button"
          onclick={() => setPicked([...alreadySaved], false)}
        >
          Untick the ones already saved
        </button>
      {/if}
    </p>

    <div class="picker">
      <label class="pick-all">
        <input
          type="checkbox"
          checked={chosen.length === ordered.length}
          indeterminate={chosen.length > 0 && chosen.length < ordered.length}
          onchange={(e) =>
            setPicked(
              ordered.map((_, i) => i),
              e.currentTarget.checked
            )}
        />
        <span class="pick-all-name">{bookCount === 0 ? 'All articles' : 'All'}</span>
        <span class="count"
          >{chosen.length.toLocaleString()} of {ordered.length.toLocaleString()}</span
        >
      </label>
      <div
        class="rows"
        role="group"
        aria-label={bookCount === 0 ? 'Articles to import' : 'Articles and books to import'}
      >
        {#each groups as group (group.source)}
          {#if groups.length > 1 && group.visible.length > 0}
            <label class="group-head">
              <input
                type="checkbox"
                checked={group.picked === group.indices.length}
                indeterminate={group.picked > 0 && group.picked < group.indices.length}
                onchange={(e) => setPicked(group.indices, e.currentTarget.checked)}
              />
              <span class="pick-all-name">{IMPORT_SOURCE_NAMES[group.source]}</span>
              <span class="count"
                >{group.picked.toLocaleString()} of {group.indices.length.toLocaleString()}</span
              >
            </label>
          {/if}
          {#each group.visible as i (i)}
            {@const save = ordered[i]}
            <label class="row">
              <input type="checkbox" checked={!skipped.has(i)} onchange={() => toggle(i)} />
              <span class="row-text">
                <span class="row-title">{save.title || save.url}</span>
                <span class="row-meta"
                  >{save.kind === 'book'
                    ? [save.author, 'Book'].filter(Boolean).join(' · ')
                    : (domainFromUrl(save.url) ?? save.url)}{alreadySaved.has(i)
                    ? ' · Already saved'
                    : save.archived && placement === 'as-exported'
                      ? ' · Archived'
                      : ''}{save.highlights.length > 0
                    ? ` · ${plural(save.highlights.length, 'highlight')}`
                    : ''}</span
                >
              </span>
            </label>
          {/each}
        {/each}
        {#if hidden > 0}
          <button type="button" class="show-more" onclick={() => (shown += LIST_PAGE * 5)}>
            Show {plural(Math.min(hidden, LIST_PAGE * 5), 'more', 'more')}
          </button>
        {/if}
      </div>
    </div>

    <fieldset class="placement">
      <legend>In your Queue</legend>
      <div class="choices">
        {#if file.mixed}
          <label class="choice" class:selected={placement === 'as-exported'}>
            <input
              type="radio"
              name="import-placement"
              value="as-exported"
              bind:group={placement}
            />
            <span class="choice-text">
              <span class="choice-name">As in {file.sources === 1 ? file.from : 'each app'}</span>
              <span class="choice-meta">Unread to your Inbox, archived to your Archive</span>
            </span>
          </label>
        {/if}
        <label class="choice" class:selected={placement === 'inbox'}>
          <input type="radio" name="import-placement" value="inbox" bind:group={placement} />
          <span class="choice-text">
            <span class="choice-name">Inbox</span>
            <span class="choice-meta">All of them, to read next</span>
          </span>
        </label>
        <label class="choice" class:selected={placement === 'archive'}>
          <input type="radio" name="import-placement" value="archive" bind:group={placement} />
          <span class="choice-text">
            <span class="choice-name">{fileOnShelf ? 'Archive, Shelf only' : 'Archive'}</span>
            <span class="choice-meta"
              >{fileOnShelf
                ? 'Out of your Inbox, kept on your Shelf'
                : 'Out of your Inbox, still in your Library'}</span
            >
          </span>
        </label>
      </div>
    </fieldset>

    <label class="shelf-toggle">
      <input type="checkbox" bind:checked={fileOnShelf} />
      <span class="choice-text">
        <span class="choice-name">Also put them on your Shelf</span>
        <span class="choice-meta"
          >{file.sources === 1
            ? `In a collection, “Imported from ${file.from}”`
            : 'In a collection for each app, named “Imported from” the app'}</span
        >
      </span>
    </label>

    <ul class="facts">
      {#if summary.tags > 0}
        <li>{plural(summary.tags, 'tag')}, kept as tags</li>
      {/if}
      {#if summary.shortlist > 0}
        <li>
          {plural(summary.shortlist, 'article')} from your Readwise Shortlist: those new here are tagged
          “shortlist”, so you can find them in your Queue
        </li>
      {/if}
      {#if summary.highlights > 0}
        <li>
          {plural(summary.highlights, 'highlight')}, attached to their {bookCount === saves.length
            ? 'books'
            : bookCount > 0
              ? 'articles and books'
              : 'articles'}
        </li>
      {/if}
      <li>
        {alreadySavedChosen > 0
          ? keptNote
          : 'Articles already in your Library are otherwise left as they are.'}
      </li>
      {#if bookCount < saves.length}
        <li>Each article's text is fetched the first time you open it.</li>
      {/if}
      {#if bookCount > 0}
        <li>
          A book comes in as its highlighted passages, in book order. The rest of the book isn't
          imported.
        </li>
      {/if}
    </ul>
    {#each warnings as warning}
      <p class="muted">{warning}</p>
    {/each}
  {:else if step === 'importing'}
    <p>Importing…</p>
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
        {#if totals.invalid > 0}
          <dt>{bookCount > 0 ? 'Skipped' : 'Skipped (no web address)'}</dt>
          <dd>{totals.invalid.toLocaleString()}</dd>
        {/if}
      </dl>
      {#if backedBy && totals.rkeys.length > 0 && copyPaused}
        <p class="muted">
          Copying into your {backedBy} collection is paused, so these wait with the rest. Resume it in
          Settings when you're ready.
        </p>
      {:else if backedBy && totals.rkeys.length > 0}
        <p class="muted">
          They're being added to your {backedBy} collection in the background. Your account accepts only
          so many new records an hour, so a large import can take a day or more, and Skyreader leaves
          room for your own posts. You can close this; Settings shows how far it has got.
        </p>
      {/if}
    {/if}
    {#if error}
      <p class="error">{error}</p>
    {/if}
  {/if}

  {#snippet footer()}
    {#if step === 'preview'}
      <button class="btn btn-secondary" onclick={reset}>Back</button>
      <button class="btn btn-primary" onclick={startImport} disabled={chosen.length === 0}>
        Import {chosenBooks === 0
          ? plural(chosen.length, 'article')
          : things(chosen.length - chosenBooks, chosenBooks)}
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

  .found {
    margin: 0 0 0.75rem;
  }

  .link-button {
    padding: 0;
    border: none;
    background: none;
    color: var(--color-primary);
    font: inherit;
    cursor: pointer;
  }

  .link-button:hover {
    text-decoration: underline;
  }

  .link-button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .picker {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .pick-all,
  .group-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
  }

  .pick-all {
    border-bottom: 1px solid var(--color-border);
  }

  .group-head {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--color-bg-secondary);
    font-size: var(--text-sm);
  }

  .pick-all-name {
    flex: 1;
    min-width: 0;
    font-weight: var(--weight-medium);
  }

  .count {
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  .rows {
    max-height: min(18rem, 38vh);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.4rem 0.75rem;
    cursor: pointer;
  }

  .row:hover {
    background: var(--color-bg-secondary);
  }

  .row input,
  .pick-all input,
  .group-head input,
  .shelf-toggle input {
    flex-shrink: 0;
    width: 1rem;
    height: 1rem;
    margin: 0.15rem 0 0;
    accent-color: var(--color-primary);
  }

  .pick-all input,
  .group-head input {
    margin-top: 0;
  }

  .row-text,
  .choice-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .row-title {
    overflow: hidden;
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-meta,
  .choice-meta {
    overflow: hidden;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .show-more {
    display: block;
    width: 100%;
    padding: 0.5rem;
    border: none;
    border-top: 1px solid var(--color-border);
    background: none;
    color: var(--color-primary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .placement {
    margin: 1rem 0 0;
    padding: 0;
    border: none;
  }

  .placement legend {
    margin-bottom: 0.4rem;
    padding: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .choice {
    display: flex;
    align-items: center;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
  }

  .choice.selected {
    border-color: var(--color-primary);
  }

  .choice.selected .choice-name {
    color: var(--color-primary);
  }

  .choice input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .choice:has(input:focus-visible) {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .choice-name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .shelf-toggle {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    margin: 0.75rem 0 0;
    padding: 0 0.1rem;
    cursor: pointer;
  }

  .facts {
    margin: 1rem 0 0;
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
