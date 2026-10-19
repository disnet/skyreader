<script lang="ts">
  // One save on the Shelf, as a cover (grid) or a row (list). The cover is the
  // save's own image (a book's own cover) when it has one, else a plain typographic
  // cover: its title over the opening of its own text (a paper's abstract, an
  // article's summary), fading out down the page, with who wrote it at the foot.
  // Books and PDFs rarely carry an image, and a placeholder graphic would be
  // decoration standing in for the text. The text is the cover.
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import LibraryChip from '$lib/components/library/LibraryChip.svelte';
  import ConnectionsBadge from '$lib/components/library/ConnectionsBadge.svelte';
  import { savedConnectionsStore } from '$lib/stores/savedConnections.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { savedCoverUrl } from '$lib/services/api';
  import { shelfStore } from '$lib/stores/shelf.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { isSavedItemArchived } from '$lib/utils/savedPile';
  import { decodeEntities } from '$lib/utils/entities';
  import { formatRelativeTime } from '$lib/utils/date';
  import { SHELF_KIND_LABEL, shelfKind, type ShelfEntry } from '$lib/utils/shelf';

  interface Props {
    entry: ShelfEntry;
    view: 'grid' | 'list';
    highlightCount: number;
    /** The collection being shown, when the Shelf is filtered to one. */
    collectionId?: string | null;
    /** Offer Move up / Move down (a collection in its own order). */
    reorderable?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    onOpen: () => void;
    /** Archive it in the Queue, or move it back to the inbox. It stays on the Shelf either way. */
    onToggleArchive: (archived: boolean) => void;
  }

  let {
    entry,
    view,
    highlightCount,
    collectionId = null,
    reorderable = false,
    isFirst = false,
    isLast = false,
    onOpen,
    onToggleArchive,
  }: Props = $props();

  let save = $derived(entry.save);
  let title = $derived(decodeEntities(save.title || '') || save.domain || save.url || 'Untitled');
  let byline = $derived(save.author || save.domain || '');
  let kind = $derived(shelfKind(save));
  // The save's own summary, unless it only repeats the title.
  let excerpt = $derived.by(() => {
    const text = decodeEntities(save.description || '').trim();
    if (!text) return '';
    const norm = (t: string) => t.toLowerCase().replace(/\W+/g, '');
    return norm(text) === norm(title) ? '' : text;
  });
  // The cover's foot: a PDF's or book's author, else the article's site.
  let coverByline = $derived(kind === 'article' ? save.domain || save.author : save.author);
  let percent = $derived(entry.progress === null ? null : Math.round(entry.progress * 100));
  let image = $derived(savedCoverUrl(save));
  let imageFailed = $state(false);
  let menuOpen = $state(false);
  // Done with in the Queue. Archiving never takes a save off the Shelf, so the
  // mark is how the Shelf shows where the same save sits in the Queue.
  let archived = $derived(isSavedItemArchived(save, itemLabelsStore.isArchived));
  // Connections other people drew off this save since the reader last looked.
  let newConnections = $derived(savedConnectionsStore.unseen(save.rkey));

  let menuItems = $derived.by(() => {
    const items: {
      label: string;
      icon?: string;
      variant?: 'default' | 'danger';
      section?: string;
      onclick: () => void;
    }[] = [
      {
        label: archived ? 'Move to inbox' : 'Archive',
        icon: archived ? 'inbox' : 'archive',
        section: 'Queue',
        onclick: () => onToggleArchive(!archived),
      },
    ];
    if (auth.user) {
      items.push({
        label: 'Add to collection',
        icon: 'folder-plus',
        section: 'Shelf',
        onclick: () => shelfStore.openPicker(save),
      });
    }
    if (collectionId && reorderable) {
      if (!isFirst) {
        items.push({
          label: 'Move up',
          icon: 'arrow-up',
          section: 'Shelf',
          onclick: () => void shelfStore.moveItem(collectionId, save.rkey, -1),
        });
      }
      if (!isLast) {
        items.push({
          label: 'Move down',
          icon: 'arrow-down',
          section: 'Shelf',
          onclick: () => void shelfStore.moveItem(collectionId, save.rkey, 1),
        });
      }
    }
    if (collectionId) {
      items.push({
        label: 'Remove from collection',
        icon: 'minus',
        section: 'Shelf',
        onclick: () => void shelfStore.removeItem(collectionId, save.rkey),
      });
    }
    items.push({
      label: 'Take off Shelf',
      icon: 'shelf',
      variant: 'danger',
      section: 'Shelf',
      onclick: () => void shelfStore.setOnShelf(save, false),
    });
    return items;
  });
</script>

{#snippet archivedChip()}
  {#if archived}
    <LibraryChip label="Archived" title="Archived in your Queue. It stays on the Shelf." />
  {/if}
{/snippet}

{#if view === 'grid'}
  <article class="shelf-card" class:menu-open={menuOpen}>
    <!-- The cover repeats the title button below it, so it's one tab stop and
         one name, not two. -->
    <button class="cover-btn" onclick={onOpen} tabindex="-1" aria-hidden="true">
      {#if image && !imageFailed}
        <img
          class="cover-img"
          src={image}
          alt=""
          loading="lazy"
          onerror={() => (imageFailed = true)}
        />
      {:else}
        <div class="cover-type" data-kind={kind} class:has-excerpt={!!excerpt}>
          <span class="cover-title">{title}</span>
          {#if excerpt}<span class="cover-excerpt">{excerpt}</span>{/if}
          {#if coverByline}<span class="cover-author">{coverByline}</span>{/if}
        </div>
      {/if}
      {#if percent !== null}
        <span class="progress" aria-label={`${percent}% read`}>
          <span class="progress-fill" style="width: {percent}%"></span>
        </span>
      {/if}
    </button>
    <div class="card-body">
      <button class="card-title" onclick={onOpen}>{title}</button>
      <div class="card-meta">
        <span class="kind">{SHELF_KIND_LABEL[kind]}</span>
        {#if byline}<span class="byline">{byline}</span>{/if}
      </div>
      {#if newConnections > 0 || archived}
        <div class="card-chip">
          {#if newConnections > 0}<ConnectionsBadge count={newConnections} />{/if}
          {#if archived}{@render archivedChip()}{/if}
        </div>
      {/if}
      <div class="card-menu">
        <PopoverMenu items={menuItems} bind:open={menuOpen} />
      </div>
    </div>
  </article>
{:else}
  <article class="row" class:menu-open={menuOpen}>
    <button class="row-main" onclick={onOpen}>
      <span class="row-icon" aria-hidden="true">
        <Icon name={kind === 'article' ? 'file-text' : 'book-open'} size={16} />
      </span>
      <span class="row-text">
        <span class="row-title">{title}</span>
        <span class="row-meta">
          <span class="kind">{SHELF_KIND_LABEL[kind]}</span>
          {#if byline}<span>{byline}</span>{/if}
          {#if percent !== null}<span>{percent}% read</span>{/if}
          {#if highlightCount > 0}
            <span class="hl"
              ><Icon name="highlighter" size={11} />
              {highlightCount}</span
            >
          {/if}
          {#if entry.lastActivityAt > 0}
            <span>Opened {formatRelativeTime(entry.lastActivityAt)}</span>
          {/if}
          {#if newConnections > 0}<ConnectionsBadge count={newConnections} />{/if}
          {@render archivedChip()}
        </span>
      </span>
    </button>
    <div class="row-menu">
      <PopoverMenu items={menuItems} bind:open={menuOpen} />
    </div>
  </article>
{/if}

<style>
  /* --- Grid --- */
  .shelf-card {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .cover-btn {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 2 / 3;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-bg-secondary);
    cursor: pointer;
  }

  .cover-btn:focus-visible,
  .card-title:focus-visible,
  .row-main:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .cover-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .cover-type {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 0.75rem;
    text-align: left;
    box-sizing: border-box;
  }

  /* A PDF is a printed page: white, like the page it opens to. */
  .cover-type[data-kind='pdf'] {
    background: var(--color-bg);
  }

  /* A book's spine edge: the one quiet cue that this is a book, not a page. */
  .cover-type[data-kind='book'] {
    border-left: 6px solid var(--color-border);
  }

  .cover-title {
    font-family: var(--font-serif);
    font-size: var(--text-lg);
    line-height: var(--leading-tight);
    color: var(--color-text);
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    flex-shrink: 0;
  }

  /* With text under it, the title steps down so the page has room to start. */
  .has-excerpt .cover-title {
    font-size: var(--text-md);
    -webkit-line-clamp: 4;
    line-clamp: 4;
  }

  /* The opening of the save's own text, running off the bottom of the page. */
  .cover-excerpt {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    font-family: var(--font-serif);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
    hyphens: auto;
    -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent);
    mask-image: linear-gradient(to bottom, #000 55%, transparent);
  }

  .cover-author {
    margin-top: auto;
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.08);
  }

  .progress-fill {
    display: block;
    height: 100%;
    background: var(--color-primary);
  }

  .card-body {
    position: relative;
    padding: 0.5rem 1.75rem 0 0;
  }

  .card-title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
    font: inherit;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    color: var(--color-text);
    cursor: pointer;
    overflow-wrap: anywhere;
  }

  .card-meta {
    display: flex;
    gap: 0.375rem;
    margin-top: 0.125rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    min-width: 0;
  }

  .byline {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kind {
    flex-shrink: 0;
    font-weight: var(--weight-medium);
  }

  .card-chip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.25rem;
  }

  .card-menu {
    position: absolute;
    top: 0.25rem;
    right: -0.25rem;
  }

  /* --- List --- */
  .row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: 8px;
    transition: background-color 0.15s;
  }

  .row:hover,
  .row.menu-open {
    background: var(--color-bg-secondary);
  }

  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 0.5rem;
    border: none;
    background: none;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
    border-radius: 8px;
  }

  .row-icon {
    flex-shrink: 0;
    margin-top: 0.125rem;
    color: var(--color-text-secondary);
  }

  .row-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .row-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    color: var(--color-text);
    overflow-wrap: anywhere;
  }

  .row-meta {
    display: flex;
    flex-wrap: wrap;
    column-gap: 0.75rem;
    row-gap: 0.125rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .hl {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .row-menu {
    flex-shrink: 0;
    padding-right: 0.25rem;
  }

  @media (prefers-color-scheme: dark) {
    .progress {
      background: rgba(255, 255, 255, 0.12);
    }
  }
</style>
