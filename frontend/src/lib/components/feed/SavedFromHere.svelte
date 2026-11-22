<script lang="ts">
  // End of an article: "Links in this article". Folded, the links the reader
  // saved out of it, so a reading session's trail can be picked up where it
  // started; unfolded, every link the article points to, each a tap from saved.
  // One list, one row style, and only there when there's something in it.
  import { savesStore } from '$lib/stores/saves.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { savesFrom, savedFromKey, savedFromLibraryHref } from '$lib/utils/savedFrom';
  import { savedItemDisplayKey } from '$lib/utils/dailyMagazine';
  import { openKeyInReader } from '$lib/utils/openInReader';
  import { articleLinks, linkTitleHint, type ArticleLink } from '$lib/utils/articleLinks';
  import { saveLink } from '$lib/utils/saveLink';
  import { decodeEntities } from '$lib/utils/entities';
  import Icon from '$lib/components/Icon.svelte';
  import type { SavedItem } from '$lib/types';

  interface Props {
    /** The open article's link. */
    url: string | null | undefined;
    /** Its title, kept on a save made from here as where it came from. */
    title?: string;
    /** The article's body as the reader shows it, to read its links from. */
    html?: string;
  }

  let { url, title, html = '' }: Props = $props();

  /** Saved links shown before the list unfolds; the Library holds them all. */
  const SHOWN = 5;
  /** Past this many links, the list gets a filter. */
  const FILTER_AT = 8;

  let saves = $derived(savesFrom(savesStore.articles, url));

  let links = $derived.by((): ArticleLink[] => {
    if (!html || typeof DOMParser === 'undefined') return [];
    return articleLinks(new DOMParser().parseFromString(html, 'text/html'), url);
  });

  /** One line of the list: a link in the article, a save made from it, or both. */
  interface Row {
    url: string;
    label: string;
    host: string;
    save?: SavedItem;
    /** The link's own words, when the row is a link in the article. */
    text?: string;
  }

  function saveRow(save: SavedItem): Row {
    const h = host(save.url, save.domain);
    return { url: save.url, label: label(save), host: save.title ? h : '', save };
  }

  // Folded: the links already saved from here, newest first, to pick up the trail.
  let foldedRows = $derived(saves.slice(0, SHOWN).map(saveRow));

  // Unfolded: every link in reading order, after any save from here that the
  // article's body doesn't link to (a link from its comments, say).
  let allRows = $derived.by((): Row[] => {
    const inBody = new Set(links.map((l) => savedFromKey(l.url)));
    const extra = saves.filter((s) => !inBody.has(savedFromKey(s.url))).map(saveRow);
    const fromLinks = links.map((l): Row => {
      const save = savesStore.getByUrl(l.url);
      if (save?.title) return { ...saveRow(save), url: l.url, text: l.text };
      const h = host(l.url);
      return { url: l.url, label: l.text || h, host: l.text ? h : '', save, text: l.text };
    });
    return [...extra, ...fromLinks];
  });

  let savedCount = $derived(allRows.filter((r) => r.save).length);
  let canUnfold = $derived(allRows.length > foldedRows.length);

  const panelId = $props.id();
  let open = $state(false);
  let query = $state('');
  // Links whose save is on its way, so a second tap doesn't save twice.
  let saving = $state<Set<string>>(new Set());

  let rows = $derived.by(() => {
    if (!open) return foldedRows;
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        (r.text ?? '').toLowerCase().includes(q) ||
        r.url.toLowerCase().includes(q)
    );
  });

  // A new article starts folded, with no filter.
  $effect(() => {
    void url;
    open = false;
    query = '';
  });

  function label(save: SavedItem): string {
    return decodeEntities(save.title ?? '') || host(save.url, save.domain) || save.url;
  }

  function host(link: string, domain?: string | null): string {
    if (domain) return domain;
    try {
      return new URL(link).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  // A saved link opens its save over the article; any other, the page.
  function openRow(e: MouseEvent, row: Row) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const save = row.save ?? savesStore.getByUrl(row.url);
    if (save && openKeyInReader(savedItemDisplayKey(save))) e.preventDefault();
  }

  // The list scrolls on its own; in paged reading the page under it turns on
  // the wheel, so a wheel the list can still take stays with the list.
  function keepWheel(e: WheelEvent) {
    const el = e.currentTarget as HTMLElement;
    const down = e.deltaY > 0;
    const canScroll = down
      ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
      : el.scrollTop > 0;
    if (canScroll) e.stopPropagation();
  }

  async function save(row: Row) {
    if (saving.has(row.url) || savesStore.getByUrl(row.url)) return;
    saving = new Set(saving).add(row.url);
    try {
      await saveLink(row.url, {
        title: linkTitleHint(row.text ?? ''),
        from: url ? { url, title } : undefined,
      });
    } finally {
      const next = new Set(saving);
      next.delete(row.url);
      saving = next;
    }
  }
</script>

{#if url && allRows.length > 0}
  <section class="saved-from-here" aria-labelledby="{panelId}-heading">
    <header class="head">
      <h2 class="heading" id="{panelId}-heading">
        Links in this article
        <span class="count">
          {allRows.length}{savedCount > 0 ? ` · ${savedCount} saved` : ''}
        </span>
      </h2>
      {#if saves.length > 0}
        <a class="library" href={savedFromLibraryHref(url)}>In your Library</a>
      {/if}
    </header>

    {#if open && allRows.length > FILTER_AT}
      <input
        class="filter"
        type="search"
        placeholder="Filter links"
        aria-label="Filter links"
        bind:value={query}
      />
    {/if}

    {#if rows.length > 0 || open}
      <ul class="rows" class:scrolls={open} id={panelId} onwheel={keepWheel}>
        {#each rows as row (row.url)}
          {@const saved = !!(row.save ?? savesStore.getByUrl(row.url))}
          {@const pending = saving.has(row.url)}
          <li class="row">
            <a
              class="link"
              href={row.url}
              target="_blank"
              rel="noopener noreferrer"
              onclick={(e) => openRow(e, row)}
            >
              <span class="title">{row.label}</span>
              {#if row.host}<span class="host">{row.host}</span>{/if}
            </a>
            {#if saved}
              <span class="action saved"><Icon name="bookmark" size={14} /> Saved</span>
            {:else if !auth.isGuest}
              <button
                type="button"
                class="action save"
                disabled={pending}
                aria-label="Save {row.label}"
                onclick={() => save(row)}
              >
                <Icon name="bookmark" size={14} />
                {pending ? 'Saving…' : 'Save'}
              </button>
            {/if}
          </li>
        {:else}
          <li class="none">No links match.</li>
        {/each}
      </ul>
    {/if}

    {#if canUnfold}
      <button
        type="button"
        class="unfold"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onclick={() => (open = !open)}
      >
        {open ? 'Show fewer' : `Show all ${allRows.length} links`}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>
    {/if}
  </section>
{/if}

<style>
  /* One list, one row style: what you saved from here first, every link on
     request. Flat, ruled like the footnotes above it, quieter than the prose. */
  .saved-from-here {
    margin: 2.5rem 0 0;
    font-family: var(--font-sans-serif);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--color-border);
  }

  .heading {
    margin: 0;
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .count {
    margin-left: 0.25rem;
    color: var(--color-text-secondary);
    font-weight: normal;
  }

  .library {
    flex-shrink: 0;
    color: var(--color-primary);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .library:hover {
    text-decoration: underline;
  }

  .filter {
    box-sizing: border-box;
    width: 100%;
    margin: 0.75rem 0 0.25rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
  }

  .filter:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .filter {
      font-size: 1rem;
    }
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* An article can link to hundreds of pages: unfolded, the list scrolls on its own. */
  .rows.scrolls {
    max-height: 24rem;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 1rem;
    border-bottom: 1px solid var(--color-border);
  }

  .link {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    min-height: 44px;
    padding: 0.625rem 0;
    box-sizing: border-box;
    color: var(--color-text);
    font-size: var(--text-md);
    text-decoration: none;
  }

  .link:hover .title {
    text-decoration: underline;
    text-decoration-color: var(--color-border);
    text-underline-offset: 3px;
  }

  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .host {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-xs);
  }

  /* The right-hand column: the same width whether it says Save or Saved. */
  .action {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: flex-end;
    gap: 0.375rem;
    min-width: 5rem;
    font-size: var(--text-sm);
  }

  .saved {
    color: var(--color-text-secondary);
  }

  .saved :global(svg path) {
    fill: currentColor;
  }

  .save {
    min-height: 32px;
    padding: 0.25rem 0.5rem;
    margin-right: -0.5rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--color-primary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .save:hover:not(:disabled) {
    background: var(--color-bg-secondary);
  }

  .save:disabled {
    color: var(--color-text-secondary);
    cursor: default;
  }

  .none {
    padding: 0.75rem 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .unfold {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 44px;
    padding: 0;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .unfold:hover {
    color: var(--color-text);
  }

  .link:focus-visible,
  .library:focus-visible,
  .save:focus-visible,
  .unfold:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  @media (prefers-reduced-motion: reduce) {
    .save {
      transition: none;
    }
  }
</style>
