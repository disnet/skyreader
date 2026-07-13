<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { SavedItem } from '$lib/types';
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { useHighlights } from '$lib/hooks/useHighlights.svelte';
  import { useLinkInterception } from '$lib/hooks/useLinkInterception.svelte';
  import { useParagraphTracking } from '$lib/hooks/useParagraphTracking.svelte';
  import { decodeEntities } from '$lib/utils/entities';
  import { safeHref } from '$lib/utils/sanitize';
  import { savedItemDisplayKey, savedItemLabelKeys } from '$lib/utils/dailyMagazine';
  import Icon from '$lib/components/Icon.svelte';
  import HighlightPopover from './HighlightPopover.svelte';
  import NotePeek from './NotePeek.svelte';
  import LinkContextMenu from './LinkContextMenu.svelte';
  import ReaderDiscussion from './ReaderDiscussion.svelte';

  export interface MagazineArticleControls {
    nextParagraph: () => void;
    previousParagraph: () => void;
    highlightParagraph: () => void;
    body: () => HTMLElement | undefined;
    root: () => HTMLElement | undefined;
  }

  let {
    item,
    index,
    count,
    minutes,
    bodyStatus,
    bodyHtml,
    active,
    scrollRoot,
    registerControls,
    registerRoot,
  }: {
    item: SavedItem;
    index: number;
    count: number;
    minutes: number;
    bodyStatus: 'loading' | 'ready' | 'missing';
    bodyHtml: string;
    active: boolean;
    scrollRoot: HTMLElement | undefined;
    registerControls: (key: string, controls: MagazineArticleControls | null) => void;
    registerRoot: (key: string, root: HTMLElement | null) => void;
  } = $props();

  let rootEl = $state<HTMLElement>();
  let bodyEl = $state<HTMLElement>();
  let itemKey = $derived(savedItemDisplayKey(item));
  let readerItem = $derived({ type: 'saved', item, key: itemKey } satisfies FeedDisplayItem);
  let originalUrl = $derived(safeHref(item.url));
  let title = $derived(decodeEntities(item.title || '') || item.url);
  let itemTags = $derived(itemLabelsStore.getTagsForItem(itemKey));

  const paragraphTracking = useParagraphTracking({
    contentEl: () => bodyEl,
    scrollRoot: () => scrollRoot,
    itemKey: () => itemKey,
    itemType: () => 'saved',
    enabled: () => active,
  });
  const linkInterception = useLinkInterception({ contentEl: () => bodyEl, enabled: () => true });
  const highlightsHook = useHighlights({
    contentEl: () => bodyEl,
    itemKey: () => itemKey,
    itemType: () => 'saved',
    enabled: () => true,
    itemUrl: () => item.url,
    itemTitle: () => title,
  });

  const controls: MagazineArticleControls = {
    nextParagraph: paragraphTracking.nextParagraph,
    previousParagraph: paragraphTracking.prevParagraph,
    highlightParagraph: () =>
      highlightsHook.toggleParagraphHighlight(paragraphTracking.currentParagraphIndex),
    body: () => bodyEl,
    root: () => rootEl,
  };

  onMount(() => {
    registerControls(itemKey, controls);
    registerRoot(itemKey, rootEl ?? null);
    const labelKeys = savedItemLabelKeys(item);
    if (!itemLabelsStore.getReadActivity(labelKeys)) {
      const primaryKey = labelKeys[0] || itemKey;
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          itemLabelsStore.markOpened(primaryKey, 'saved');
          observer.disconnect();
        },
        { threshold: 0 }
      );
      if (rootEl) observer.observe(rootEl);
      return () => {
        observer.disconnect();
        registerControls(itemKey, null);
        registerRoot(itemKey, null);
      };
    }
    return () => {
      registerControls(itemKey, null);
      registerRoot(itemKey, null);
    };
  });

  $effect(() => {
    void bodyHtml;
    void bodyStatus;
    void active;
    if (!bodyEl) return;
    let cancelled = false;
    tick().then(() => {
      if (cancelled) return;
      if (active) paragraphTracking.setupObserver();
      linkInterception.attach();
      highlightsHook.attach();
    });
    return () => {
      cancelled = true;
      paragraphTracking.cleanup();
      linkInterception.detach();
      highlightsHook.detach();
    };
  });
</script>

<article id={`article-${index + 1}`} class="issue-article" class:active bind:this={rootEl}>
  <header class="article-header">
    <p class="article-number">Article {index + 1} of {count}</p>
    <h2>{title}</h2>
    <div class="article-meta">
      {#if item.author}<span>{item.author}</span><span aria-hidden="true">·</span>{/if}
      <span>{minutes} min read</span>
    </div>
    {#if itemTags.length}
      <div class="reader-tags">
        {#each itemTags as tag}<span>{tag}</span>{/each}
      </div>
    {/if}
    {#if originalUrl}
      <a class="original-link" href={originalUrl} target="_blank" rel="noopener noreferrer">
        <span>Open original</span><Icon name="external-link" size={14} />
      </a>
    {/if}
  </header>

  <div class="body-wrapper">
    <div class="article-body" bind:this={bodyEl} use:bskyEmbed>
      {#if bodyStatus === 'loading'}
        <p class="body-state" aria-live="polite">Loading saved copy…</p>
      {:else if bodyStatus === 'missing'}
        <div class="body-state missing">
          <p>The saved copy isn’t available on this device.</p>
          {#if originalUrl}<a href={originalUrl} target="_blank" rel="noopener noreferrer"
              >Read the original article</a
            >{/if}
        </div>
      {:else}
        {@html bodyHtml}
      {/if}
    </div>
  </div>

  <ReaderDiscussion {readerItem} panelId={`daily-discussion-${index + 1}`} />
</article>

{#if linkInterception.menuState}
  {#key linkInterception.menuState.url + linkInterception.menuState.anchorRect.top}
    <LinkContextMenu
      url={linkInterception.menuState.url}
      linkText={linkInterception.menuState.linkText}
      anchorRect={linkInterception.menuState.anchorRect}
      onClose={linkInterception.closeMenu}
    />
  {/key}
{/if}

{#if highlightsHook.popoverState}
  <HighlightPopover
    mode={highlightsHook.popoverState.mode}
    anchorRect={highlightsHook.popoverState.anchorRect}
    onHighlight={highlightsHook.createHighlightFromPopover}
    onHighlightToMargin={highlightsHook.createHighlightFromPopoverToMargin}
    onRemove={highlightsHook.removeHighlightFromPopover}
    onSaveToMargin={highlightsHook.savePopoverHighlightToMargin}
    onSaveNote={highlightsHook.saveNoteFromPopover}
    existingNote={highlightsHook.popoverHighlightNote}
    marginSaved={highlightsHook.popoverHighlightSavedToMargin}
    onClose={highlightsHook.closePopover}
  />
{/if}

{#if highlightsHook.notePeek}
  <NotePeek note={highlightsHook.notePeek.note} anchorRect={highlightsHook.notePeek.anchorRect} />
{/if}

<style>
  .issue-article {
    padding: clamp(2.75rem, 8vw, 4.75rem) 0;
    border-bottom: 1px solid var(--color-border);
    scroll-margin-top: 4rem;
  }
  .issue-article:last-child {
    border-bottom: 0;
  }
  .article-header {
    display: grid;
    gap: 0.5rem;
    margin-bottom: 2rem;
    font-family: var(--font-sans-serif);
  }
  .article-number {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }
  .article-header h2 {
    max-width: 28ch;
    margin: 0;
    color: var(--color-text);
    font-size: var(--text-4xl);
    line-height: var(--leading-tight);
    letter-spacing: var(--tracking-tight);
  }
  .article-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
  .original-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    width: fit-content;
    margin-top: 0.25rem;
    border-radius: 4px;
    color: var(--color-primary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    text-decoration: none;
  }
  .original-link:hover {
    text-decoration: underline;
  }
  .reader-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .reader-tags span {
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
    color: var(--color-primary);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
  }
  .body-wrapper {
    position: relative;
  }
  .article-body {
    position: relative;
    color: var(--color-text);
    font-family: var(--article-font, Georgia, 'Times New Roman', serif);
    font-size: var(--article-font-size, 1.0625rem);
    line-height: 1.8;
    overflow-wrap: break-word;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  .article-body :global(p) {
    margin: 1rem 0;
  }
  .article-body :global(p:first-child) {
    margin-top: 0;
  }
  .article-body :global(h1),
  .article-body :global(h2),
  .article-body :global(h3),
  .article-body :global(h4) {
    margin: 1.5rem 0 0.75rem;
    line-height: var(--leading-tight);
  }
  .article-body :global(a) {
    color: var(--color-primary);
  }
  .article-body :global(img),
  .article-body :global(svg),
  .article-body :global(video) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }
  .article-body :global(iframe) {
    display: block;
    width: 100%;
    max-width: 100%;
    aspect-ratio: 16/9;
    border: 0;
  }
  .article-body :global(pre) {
    max-width: 100%;
    padding: 1rem;
    overflow-x: auto;
    border-radius: 6px;
    background: var(--color-bg-secondary);
  }
  .article-body :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }
  .article-body :global(blockquote) {
    margin: 1rem 0;
    padding-left: 1rem;
    border-left: 3px solid var(--color-border);
    color: var(--color-text-secondary);
  }
  .article-body :global(mark.highlight) {
    border-radius: 1px;
    background-color: color-mix(in srgb, #f5c518 25%, transparent);
    cursor: pointer;
  }
  .article-body :global(mark.highlight:hover) {
    background-color: color-mix(in srgb, #f5c518 40%, transparent);
  }
  .body-state {
    margin: 0;
    color: var(--color-text-secondary);
    font-family: var(--font-sans-serif);
  }
  .body-state.missing {
    display: grid;
    gap: 0.5rem;
    padding: 1rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-secondary);
  }
  .body-state.missing p {
    margin: 0;
  }
  @media (max-width: 640px) {
    .article-header h2 {
      font-size: 1.375rem;
    }
  }
</style>
