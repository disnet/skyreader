<script lang="ts">
  import { marked } from 'marked';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import Icon from '$lib/components/Icon.svelte';
  import type { ReaderCollection, ReaderCollectionItem } from '$lib/types';

  let {
    collection,
    onOpenPiece,
    onSavePiece,
    isPieceSaved,
  }: {
    collection: ReaderCollection;
    // Open a piece in the in-app reader. When absent (e.g. a context that isn't
    // stack-aware), the "Open in viewer" action is hidden and the card still
    // offers "Open in new tab" via the canonical URL.
    onOpenPiece?: (item: ReaderCollectionItem) => void | Promise<void>;
    // Toggle a piece into the Saved list. May be async (a save fetches the full
    // document first), so it can return a promise. Hidden when absent.
    onSavePiece?: (item: ReaderCollectionItem) => void | Promise<void>;
    // Reactive saved-state predicate for a piece (drives the Save → Saved label).
    isPieceSaved?: (item: ReaderCollectionItem) => boolean;
  } = $props();

  // The piece currently being fetched + opened, so its viewer button can show a
  // pending hint while the document is resolved on demand.
  let pendingUri = $state<string | null>(null);
  // The piece whose save is in flight (a save fetches the full document), so its
  // Save button disables — guards against a double-click creating two saves.
  let savingUri = $state<string | null>(null);

  async function openPiece(item: ReaderCollectionItem) {
    if (!onOpenPiece) return;
    pendingUri = item.document;
    try {
      await onOpenPiece(item);
    } finally {
      pendingUri = null;
    }
  }

  async function savePiece(item: ReaderCollectionItem) {
    if (!onSavePiece || savingUri) return;
    savingUri = item.document;
    try {
      await onSavePiece(item);
    } finally {
      savingUri = null;
    }
  }

  // Editorial intro / per-item notes / colophon are GFM markdown strings (not the
  // structured `content` body the article reader renders). Render them with the
  // same `marked` path markpub-renderer uses, then sanitize.
  function md(body: string | undefined, base = ''): string {
    if (!body) return '';
    return sanitizeHtml(marked.parse(body, { gfm: true, async: false }) as string, base);
  }

  let editorialHtml = $derived(md(collection.editorial?.body));
  let colophonHtml = $derived(md(collection.colophon?.body));

  // Source label for an item: its publication hostname, falling back to nothing.
  function sourceLabel(item: ReaderCollectionItem): string {
    if (!item.canonicalUrl) return '';
    try {
      return new URL(item.canonicalUrl).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function itemFavicon(item: ReaderCollectionItem): string {
    if (item.siteIcon) return item.siteIcon;
    if (item.canonicalUrl) return getFaviconUrl(item.canonicalUrl);
    return '';
  }
</script>

<div class="collection">
  {#if editorialHtml}
    <div class="collection-editorial reader-prose">{@html editorialHtml}</div>
  {/if}

  <!-- Plain divs (not <ol>/<li>): this renders inside the article-body / reader
       prose, whose global list styles would otherwise indent and space the
       items. The position is shown explicitly ("N of M"). -->
  <div class="collection-items">
    <!-- Keyed by URI + index: an edition may list the same document twice (curator
         authored), and a bare URI key would collide and throw. -->
    {#each collection.items as item, i (item.document + '#' + i)}
      {@const favicon = itemFavicon(item)}
      {@const source = sourceLabel(item)}
      {@const saved = isPieceSaved?.(item) ?? false}
      {@const canOpenViewer = Boolean(onOpenPiece)}
      <div class="collection-item">
        <!-- The curator's commentary, as plain prose leading into the piece. -->
        {#if item.note}
          <div class="collection-item-note reader-prose">
            {@html md(item.note, item.canonicalUrl)}
          </div>
        {/if}

        <!-- The piece itself, as a flat embedded card (1px hairline, no shadow —
             per DESIGN.md it isn't floating). -->
        <div class="piece-card">
          <div class="piece-main">
            {#if favicon || source}
              <div class="piece-source">
                {#if favicon}
                  <img src={favicon} alt="" class="piece-favicon" />
                {/if}
                {#if source}<span class="piece-source-name">{source}</span>{/if}
                <span class="piece-index" aria-hidden="true"
                  >{i + 1} of {collection.items.length}</span
                >
              </div>
            {/if}

            <p class="piece-title">{item.title || item.canonicalUrl || 'Untitled piece'}</p>

            {#if item.description}
              <p class="piece-desc">{item.description}</p>
            {/if}
          </div>

          <div class="piece-actions">
            {#if onSavePiece}
              <button
                type="button"
                class="piece-btn"
                class:saved
                class:is-pending={savingUri === item.document}
                disabled={savingUri === item.document}
                title={saved ? 'Saved to read later. Tap to remove' : 'Save to read later'}
                onclick={(e) => {
                  e.stopPropagation();
                  savePiece(item);
                }}
              >
                <Icon name="bookmark" size={15} />
                <span>{savingUri === item.document ? 'Saving…' : saved ? 'Saved' : 'Save'}</span>
              </button>
            {/if}

            {#if canOpenViewer}
              <button
                type="button"
                class="piece-btn"
                class:is-pending={pendingUri === item.document}
                disabled={pendingUri !== null}
                title="Open in the reader"
                onclick={(e) => {
                  e.stopPropagation();
                  openPiece(item);
                }}
              >
                <Icon name="maximize" size={15} />
                <span>{pendingUri === item.document ? 'Opening…' : 'Open in viewer'}</span>
              </button>
            {/if}

            {#if item.canonicalUrl}
              <a
                class="piece-btn"
                href={item.canonicalUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in a new tab"
              >
                <Icon name="external-link" size={15} />
                <span>New tab</span>
              </a>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>

  {#if colophonHtml}
    <div class="collection-colophon reader-prose">{@html colophonHtml}</div>
  {/if}
</div>

<style>
  .collection {
    font-family: var(--article-font, Georgia, 'Times New Roman', serif);
    font-size: var(--article-font-size, 1.0625rem);
    line-height: 1.8;
    color: var(--color-text);
  }

  /* Editorial intro + colophon read like body prose. */
  .reader-prose :global(p) {
    margin: 1rem 0;
  }
  .reader-prose :global(p:first-child) {
    margin-top: 0;
  }
  .reader-prose :global(p:last-child) {
    margin-bottom: 0;
  }
  .reader-prose :global(a) {
    color: var(--color-primary, #0066cc);
  }
  .reader-prose :global(strong) {
    font-weight: var(--weight-semibold);
  }

  .collection-editorial {
    margin-bottom: 1.25rem;
  }

  .collection-items {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* Each entry stacks the curator's note above the piece it introduces. */
  .collection-item {
    margin: 0 0 1rem;
  }

  .collection-item:last-child {
    margin-bottom: 0;
  }

  /* The commentary: plain prose in a quieter secondary tone, the curator
     speaking before handing you the piece. Aligned flush with the card below. */
  .collection-item-note {
    margin: 0 0 0.5rem;
    font-size: var(--text-md);
    line-height: 1.55;
    color: var(--color-text-secondary);
  }

  .collection-item-note :global(p) {
    margin: 0.3rem 0;
  }

  /* The piece card. Flat by default — a hairline border + faint surface tint, no
     shadow (it isn't floating). Tight padding so the title sits close to the
     editorial column rather than reading as a deeply inset box. */
  .piece-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border, #e8e8e8);
    border-radius: 8px;
    background: var(--color-bg-secondary, #fafafa);
    /* Reset the reading line-height (1.8) the prose container sets — the card is
       UI, so its rows stay compact. */
    line-height: var(--leading-snug, 1.35);
  }

  .piece-main {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .piece-source {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: var(--text-sm);
    line-height: var(--leading-normal, 1.5);
    color: var(--color-text-secondary);
  }

  .piece-favicon {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .piece-source-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .piece-index {
    flex-shrink: 0;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--color-text-tertiary, #9ca3af);
  }

  .piece-title {
    margin: 0;
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-snug, 1.35);
    color: var(--color-text);
    overflow-wrap: break-word;
  }

  .piece-desc {
    margin: 0;
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: var(--text-md);
    line-height: 1.5;
    color: var(--color-text-secondary);
    /* Keep the excerpt to a couple of lines so cards stay scannable. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .piece-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  /* Quiet pill buttons. Neutral at rest, One Blue on hover — color is the single
     interaction event. The Save toggle flips to success green once filed. */
  .piece-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.625rem;
    background: none;
    border: 1px solid var(--color-border, #e5e5e5);
    border-radius: 999px;
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    text-decoration: none;
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }

  .piece-btn:hover {
    color: var(--color-primary, #0066cc);
    border-color: var(--color-primary, #0066cc);
  }

  .piece-btn.saved,
  .piece-btn.saved:hover {
    color: var(--color-success, #4caf50);
    border-color: var(--color-success, #4caf50);
  }

  .piece-btn.saved :global(.icon) {
    fill: currentColor;
  }

  .piece-btn.is-pending {
    color: var(--color-text-secondary);
    cursor: progress;
  }

  .piece-btn:disabled:not(.is-pending) {
    opacity: 0.5;
    cursor: default;
  }

  .collection-colophon {
    margin-top: 2rem;
    font-style: italic;
    color: var(--color-text-secondary);
  }

  @media (prefers-color-scheme: dark) {
    .piece-card {
      background: var(--color-bg-secondary, #1f1f1f);
      border-color: var(--color-border, #333);
    }
  }
</style>
