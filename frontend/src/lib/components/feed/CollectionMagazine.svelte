<script lang="ts">
  import { marked } from 'marked';
  import { sanitizeHtml } from '$lib/utils/sanitize';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { getDisplayContent } from '$lib/utils/displayItem';
  import { decodeEntities } from '$lib/utils/entities';
  import { fetchCollectionDoc } from '$lib/utils/collectionPiece';
  import { magazineThemeVars, magazineFontHref } from '$lib/utils/magazineTheme';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import Icon from '$lib/components/Icon.svelte';
  import type { ReaderCollection, ReaderCollectionItem, SocialDocument } from '$lib/types';

  let {
    collection,
    title,
    onSavePiece,
    isPieceSaved,
  }: {
    collection: ReaderCollection;
    // The edition's title (the document title, e.g. "Inflection points"), shown as
    // the masthead's large display headline. Lives on the document, not the
    // collection, so it's passed in by the host.
    title?: string;
    // Toggle a piece into the Saved list (async — fetches the full document first).
    onSavePiece?: (item: ReaderCollectionItem) => void | Promise<void>;
    // Reactive saved-state predicate for a piece.
    isPieceSaved?: (item: ReaderCollectionItem) => boolean;
  } = $props();

  let savingUri = $state<string | null>(null);

  async function savePiece(item: ReaderCollectionItem) {
    if (!onSavePiece || savingUri) return;
    savingUri = item.document;
    try {
      await onSavePiece(item);
    } finally {
      savingUri = null;
    }
  }

  // Editorial / per-item commentary / colophon are GFM markdown strings.
  function md(body: string | undefined, base = ''): string {
    if (!body) return '';
    return sanitizeHtml(marked.parse(body, { gfm: true, async: false }) as string, base);
  }

  function isExternal(item: ReaderCollectionItem): boolean {
    return !item.document?.startsWith('at://');
  }

  // Title shown as plain text — decode HTML entities feeds/publishers ship raw
  // (e.g. `&#8211;`), which Svelte would otherwise render literally.
  function pieceTitle(item: ReaderCollectionItem): string {
    return decodeEntities(item.title) || item.canonicalUrl || 'Untitled piece';
  }

  // Source label: the resolved publication name, else the canonical URL hostname.
  function sourceLabel(item: ReaderCollectionItem): string {
    if (item.sourceName) return decodeEntities(item.sourceName);
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

  function pad(n: number): string {
    return n < 100 ? String(n).padStart(2, '0') : String(n);
  }

  // Each curated piece's full body is fetched on demand and rendered inline (the
  // same render pipeline the reader uses for a single document). Keyed by at:// URI.
  // `started` is a plain Set (non-reactive) so the effect doesn't re-run on its own
  // writes; results land in the reactive `pieces` map.
  type PieceState = { status: 'loading' | 'done' | 'error'; html?: string };
  let pieces = $state<Record<string, PieceState>>({});
  const started = new Set<string>();

  $effect(() => {
    for (const item of collection.items) {
      const uri = item.document;
      if (!uri || !uri.startsWith('at://') || started.has(uri)) continue;
      started.add(uri);
      pieces[uri] = { status: 'loading' };
      fetchCollectionDoc(uri)
        .then((doc: SocialDocument | null) => {
          if (!doc) {
            pieces[uri] = { status: 'error' };
            return;
          }
          const raw = getDisplayContent({ type: 'document', item: doc, key: doc.recordUri });
          pieces[uri] = {
            status: 'done',
            html: sanitizeHtml(raw, doc.canonicalUrl || doc.path || ''),
          };
        })
        .catch(() => {
          pieces[uri] = { status: 'error' };
        });
    }
  });

  let themeVars = $derived(magazineThemeVars(collection));
  let fontHref = $derived(magazineFontHref(collection));
  let editorialHtml = $derived(md(collection.editorial?.body));
  let colophonHtml = $derived(md(collection.colophon?.body));
  let issueTitle = $derived(
    decodeEntities(title?.trim() || collection.publicationName) || 'Untitled edition'
  );
</script>

<svelte:head>
  {#if fontHref}
    <link rel="stylesheet" href={fontHref} />
  {/if}
</svelte:head>

<div class="magazine" style={themeVars}>
  <header class="masthead">
    <div class="masthead-rule" aria-hidden="true"></div>
    {#if collection.publicationName}
      <p class="masthead-pub">{decodeEntities(collection.publicationName)}</p>
    {/if}
    <h1 class="masthead-title">{issueTitle}</h1>
    <p class="masthead-meta">
      {#if collection.authorHandle}<span>@{collection.authorHandle}</span> ·
      {/if}
      <span>{collection.items.length} {collection.items.length === 1 ? 'feature' : 'features'}</span
      >
    </p>
  </header>

  {#if collection.editorial?.title || editorialHtml}
    <div class="magazine-editorial">
      {#if collection.editorial?.title}
        <h2 class="editorial-title">{decodeEntities(collection.editorial.title)}</h2>
      {/if}
      {#if editorialHtml}
        <div class="reader-prose">{@html editorialHtml}</div>
      {/if}
    </div>
  {/if}

  <!-- Table of contents: jumps down to each inline piece, with a save toggle. -->
  <nav class="toc" aria-label="In this issue">
    <p class="toc-label">In this issue</p>
    {#each collection.items as item, i (item.document + '#' + i)}
      {@const source = sourceLabel(item)}
      {@const saved = isPieceSaved?.(item) ?? false}
      <div class="toc-entry">
        <a class="toc-link" href={`#piece-${i}`}>
          <span class="toc-index" aria-hidden="true">{pad(i + 1)}</span>
          <span class="toc-title">{pieceTitle(item)}</span>
          {#if source}<span class="toc-source">{source}</span>{/if}
        </a>
        {#if onSavePiece}
          <button
            type="button"
            class="toc-save"
            class:saved
            disabled={savingUri === item.document}
            title={saved ? 'Saved to read later. Tap to remove' : 'Save to read later'}
            onclick={() => savePiece(item)}
          >
            <Icon name="bookmark" size={16} />
          </button>
        {/if}
      </div>
    {/each}
  </nav>

  <!-- Every piece inlined: a heading, the curator's commentary as a blockquote,
       then the full article body. Bsky embeds in any body hydrate via the action. -->
  <div class="pieces" use:bskyEmbed>
    {#each collection.items as item, i (item.document + '#' + i)}
      {@const source = sourceLabel(item)}
      {@const favicon = itemFavicon(item)}
      {@const st = pieces[item.document]}
      <article class="piece" id={`piece-${i}`}>
        <header class="piece-head">
          <span class="piece-num" aria-hidden="true">{pad(i + 1)}</span>
          <div class="piece-heading">
            <h2 class="piece-title">{pieceTitle(item)}</h2>
            {#if source}
              <span class="piece-source">
                {#if favicon}<img src={favicon} alt="" class="piece-favicon" />{/if}
                {source}
              </span>
            {/if}
          </div>
          {#if item.canonicalUrl}
            <a
              class="piece-link"
              href={item.canonicalUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the original in a new tab"
            >
              <Icon name="external-link" size={16} />
            </a>
          {/if}
        </header>

        {#if item.note}
          <blockquote class="piece-commentary reader-prose">
            {@html md(item.note, item.canonicalUrl)}
          </blockquote>
        {/if}

        {#if isExternal(item)}
          <p class="piece-status">
            {#if item.canonicalUrl}
              <a href={item.canonicalUrl} target="_blank" rel="noopener noreferrer">
                Read the full piece at {source || 'the source'} →
              </a>
            {:else}
              This piece links out and isn't rendered in-app.
            {/if}
          </p>
        {:else if !st || st.status === 'loading'}
          <p class="piece-status">Loading…</p>
        {:else if st.status === 'error'}
          <p class="piece-status">
            Couldn't load this piece.
            {#if item.canonicalUrl}
              <a href={item.canonicalUrl} target="_blank" rel="noopener noreferrer"
                >Read the original →</a
              >
            {/if}
          </p>
        {:else}
          <div class="piece-content">{@html st.html}</div>
        {/if}
      </article>
    {/each}
  </div>

  {#if colophonHtml}
    <div class="magazine-colophon reader-prose">{@html colophonHtml}</div>
  {/if}
</div>

<style>
  .magazine {
    background: var(--mag-bg);
    color: var(--mag-fg);
    font-family: var(--mag-body-font, var(--article-font, Georgia, 'Times New Roman', serif));
    padding-bottom: 2rem;
    min-height: 100%;
  }

  /* --- Masthead --- */
  .masthead {
    margin-bottom: 2.5rem;
  }
  .masthead-rule {
    height: 3px;
    background: var(--mag-accent);
    margin-bottom: 1.75rem;
  }
  .masthead-pub {
    margin: 0 0 0.75rem;
    font-family: var(--mag-label-font, var(--font-sans, system-ui, sans-serif));
    font-size: var(--text-sm, 0.8125rem);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--mag-accent);
  }
  .masthead-title {
    margin: 0;
    font-family: var(--mag-title-font, var(--article-font, Georgia, 'Times New Roman', serif));
    font-style: var(--mag-title-style, italic);
    font-weight: 600;
    font-size: clamp(2.25rem, 8vw, 3.5rem);
    line-height: 1.05;
    color: var(--mag-fg);
  }
  .masthead-meta {
    margin: 1rem 0 0;
    font-family: var(--mag-label-font, var(--font-sans, system-ui, sans-serif));
    font-size: var(--text-sm, 0.8125rem);
    opacity: 0.7;
  }

  /* Prose shared by editorial / commentary / colophon. */
  .reader-prose :global(p) {
    margin: 1rem 0;
    line-height: 1.7;
  }
  .reader-prose :global(p:first-child) {
    margin-top: 0;
  }
  .reader-prose :global(p:last-child) {
    margin-bottom: 0;
  }
  .reader-prose :global(a) {
    color: var(--mag-accent);
  }
  .reader-prose :global(strong) {
    font-weight: var(--weight-semibold);
  }

  .magazine-editorial {
    margin-bottom: 2.5rem;
    font-size: 1.0625rem;
  }
  .editorial-title {
    margin: 0 0 0.75rem;
    font-family: var(--mag-title-font, var(--article-font, Georgia, 'Times New Roman', serif));
    font-style: var(--mag-title-style, italic);
    font-weight: 600;
    font-size: 1.5rem;
    line-height: 1.2;
    color: var(--mag-fg);
  }

  /* --- Table of contents --- */
  .toc {
    margin-bottom: 3rem;
  }
  .toc-label {
    margin: 0 0 0.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 2px solid var(--mag-accent);
    font-family: var(--mag-label-font, var(--font-sans, system-ui, sans-serif));
    font-size: var(--text-sm, 0.8125rem);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--mag-accent);
  }
  .toc-entry {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid color-mix(in srgb, var(--mag-fg) 14%, transparent);
  }
  .toc-link {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: 2.25rem 1fr auto;
    gap: 0 0.875rem;
    align-items: baseline;
    text-decoration: none;
    color: inherit;
  }
  .toc-link:hover .toc-title {
    color: var(--mag-accent);
  }
  .toc-save {
    flex-shrink: 0;
    align-self: center;
    display: inline-flex;
    align-items: center;
    padding: 0.25rem;
    background: none;
    border: none;
    color: var(--mag-fg);
    opacity: 0.55;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }
  .toc-save:hover {
    opacity: 1;
    color: var(--mag-accent);
  }
  .toc-save.saved {
    opacity: 1;
    color: var(--mag-accent);
  }
  .toc-save.saved :global(.icon) {
    fill: currentColor;
  }
  .toc-save:disabled {
    cursor: progress;
  }
  .toc-index {
    font-variant-numeric: tabular-nums;
    font-size: var(--text-sm, 0.8125rem);
    font-weight: 600;
    color: var(--mag-accent);
  }
  .toc-title {
    font-size: 1.1875rem;
    line-height: 1.3;
    color: var(--mag-fg);
  }
  .toc-source {
    justify-self: end;
    font-family: var(--mag-label-font, var(--font-sans, system-ui, sans-serif));
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--weight-medium);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.75;
    white-space: nowrap;
  }

  /* --- Inline pieces --- */
  .piece {
    /* Clear the sticky reader header when a TOC link jumps here. */
    scroll-margin-top: 4.5rem;
    padding: 2.5rem 0;
    border-top: 1px solid color-mix(in srgb, var(--mag-fg) 14%, transparent);
  }
  .piece:first-child {
    border-top: none;
    padding-top: 0;
  }

  .piece-head {
    display: flex;
    align-items: baseline;
    gap: 0.875rem;
    margin-bottom: 1rem;
  }
  .piece-num {
    font-variant-numeric: tabular-nums;
    font-size: var(--text-sm, 0.8125rem);
    font-weight: 600;
    color: var(--mag-accent);
    flex-shrink: 0;
  }
  .piece-heading {
    flex: 1;
    min-width: 0;
  }
  .piece-title {
    margin: 0;
    font-family: var(--mag-title-font, var(--article-font, Georgia, 'Times New Roman', serif));
    font-style: var(--mag-title-style, italic);
    font-weight: 600;
    font-size: clamp(1.5rem, 4vw, 2rem);
    line-height: 1.15;
    color: var(--mag-fg);
  }
  .piece-source {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.375rem;
    font-family: var(--mag-label-font, var(--font-sans, system-ui, sans-serif));
    font-size: var(--text-xs, 0.75rem);
    font-weight: var(--weight-medium);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.7;
  }
  .piece-favicon {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .piece-link {
    flex-shrink: 0;
    align-self: center;
    display: inline-flex;
    align-items: center;
    padding: 0.25rem;
    background: none;
    border: none;
    color: var(--mag-fg);
    opacity: 0.55;
    cursor: pointer;
    transition: opacity 0.15s ease;
  }
  .piece-link:hover {
    opacity: 1;
    color: var(--mag-accent);
  }

  /* Curator commentary: a blockquote leading into the piece. */
  .piece-commentary {
    margin: 0 0 1.5rem;
    padding: 0.25rem 0 0.25rem 1rem;
    border-left: 3px solid var(--mag-accent);
    font-size: 1.0625rem;
    font-style: italic;
    opacity: 0.85;
  }

  .piece-status {
    margin: 1.5rem 0;
    font-family: var(--mag-label-font, var(--font-sans, system-ui, sans-serif));
    font-size: var(--text-sm, 0.8125rem);
    opacity: 0.7;
  }
  .piece-status :global(a) {
    color: var(--mag-accent);
  }

  /* The inlined article body. */
  .piece-content {
    font-size: 1.0625rem;
    line-height: 1.7;
  }
  .piece-content :global(p) {
    margin: 1rem 0;
  }
  .piece-content :global(h1),
  .piece-content :global(h2),
  .piece-content :global(h3) {
    font-family: var(--mag-title-font, var(--article-font, Georgia, 'Times New Roman', serif));
    line-height: 1.25;
    margin: 1.75rem 0 0.75rem;
  }
  .piece-content :global(a) {
    color: var(--mag-accent);
  }
  .piece-content :global(img),
  .piece-content :global(svg),
  .piece-content :global(video) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
  }
  .piece-content :global(iframe) {
    display: block;
    width: 100%;
    max-width: 100%;
    aspect-ratio: 16 / 9;
    height: auto;
    border: 0;
    border-radius: 6px;
    margin: 1rem 0;
  }
  .piece-content :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }
  .piece-content :global(blockquote) {
    margin: 1rem 0;
    padding-left: 1rem;
    border-left: 3px solid color-mix(in srgb, var(--mag-fg) 25%, transparent);
    opacity: 0.85;
  }
  .piece-content :global(pre) {
    overflow-x: auto;
    padding: 0.875rem 1rem;
    border-radius: 6px;
    background: color-mix(in srgb, var(--mag-fg) 8%, transparent);
    font-size: 0.9375rem;
  }
  .piece-content :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
  }
  .piece-content :global(hr) {
    margin: 2rem 0;
    border: none;
    border-top: 1px solid color-mix(in srgb, var(--mag-fg) 18%, transparent);
  }

  .magazine-colophon {
    margin-top: 2.5rem;
    padding-top: 2rem;
    border-top: 1px solid color-mix(in srgb, var(--mag-fg) 14%, transparent);
    font-style: italic;
    font-size: 0.9375rem;
    opacity: 0.7;
  }
</style>
