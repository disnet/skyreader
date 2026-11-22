<script lang="ts">
  // End of an article: the links the reader saved out of it, so a reading
  // session's trail can be picked up from where it started, and, folded away
  // until asked for, every link the article points to, each a tap from saved.
  // Quiet, and only there when there's something in it.
  import { savesStore } from '$lib/stores/saves.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { savesFrom, savedFromLibraryHref } from '$lib/utils/savedFrom';
  import { savedItemDisplayKey } from '$lib/utils/dailyMagazine';
  import { openKeyInReader } from '$lib/utils/openInReader';
  import { articleLinks, type ArticleLink } from '$lib/utils/articleLinks';
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

  /** Enough to pick up the trail; the Library holds the rest. */
  const SHOWN = 5;
  /** Past this many links, the list gets a filter. */
  const FILTER_AT = 8;

  let saves = $derived(savesFrom(savesStore.articles, url));
  let shown = $derived(saves.slice(0, SHOWN));

  let links = $derived.by((): ArticleLink[] => {
    if (!html || typeof DOMParser === 'undefined') return [];
    return articleLinks(new DOMParser().parseFromString(html, 'text/html'), url);
  });

  let linksOpen = $state(false);
  let query = $state('');
  // Links whose save is on its way, so a second tap doesn't save twice.
  let saving = $state<Set<string>>(new Set());

  let visibleLinks = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return links;
    return links.filter((l) => l.text.toLowerCase().includes(q) || l.url.toLowerCase().includes(q));
  });
  let savedCount = $derived(links.filter((l) => savesStore.getByUrl(l.url)).length);

  // A new article starts folded, with no filter.
  $effect(() => {
    void url;
    linksOpen = false;
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

  function openSave(save: SavedItem) {
    if (!openKeyInReader(savedItemDisplayKey(save))) {
      window.open(save.url, '_blank', 'noopener');
    }
  }

  // A saved link opens its save over the article; any other, the page.
  function openLink(e: MouseEvent, link: ArticleLink) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const save = savesStore.getByUrl(link.url);
    if (save && openKeyInReader(savedItemDisplayKey(save))) e.preventDefault();
  }

  async function save(link: ArticleLink) {
    if (saving.has(link.url) || savesStore.getByUrl(link.url)) return;
    saving = new Set(saving).add(link.url);
    try {
      await saveLink(link.url, {
        title: link.text.length >= 12 ? link.text : undefined,
        from: url ? { url, title } : undefined,
      });
    } finally {
      const next = new Set(saving);
      next.delete(link.url);
      saving = next;
    }
  }
</script>

{#if url && (saves.length > 0 || links.length > 0)}
  <section class="saved-from-here" aria-label="Links in this article">
    {#if saves.length > 0}
      <h2 class="heading">
        {saves.length === 1
          ? 'A link you saved from this'
          : `${saves.length} links you saved from this`}
      </h2>
      <ul>
        {#each shown as save (save.rkey)}
          <li>
            <button type="button" class="row" onclick={() => openSave(save)}>
              <span class="title">{label(save)}</span>
              {#if save.title && host(save.url, save.domain)}
                <span class="host">{host(save.url, save.domain)}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      <a class="all" href={savedFromLibraryHref(url)}>
        {saves.length > SHOWN
          ? `See all ${saves.length} in your Library`
          : 'See them in your Library'}
      </a>
    {/if}

    {#if links.length > 0}
      <button
        type="button"
        class="links-toggle"
        class:spaced={saves.length > 0}
        aria-expanded={linksOpen}
        aria-controls="article-links-list"
        onclick={() => (linksOpen = !linksOpen)}
      >
        <Icon name={linksOpen ? 'chevron-down' : 'chevron-right'} size={14} />
        All links in this article
        <span class="count">
          {links.length}{savedCount > 0 ? ` · ${savedCount} saved` : ''}
        </span>
      </button>
      {#if linksOpen}
        <div class="links-panel" id="article-links-list">
          {#if links.length > FILTER_AT}
            <input
              class="links-filter"
              type="search"
              placeholder="Filter links"
              aria-label="Filter links"
              bind:value={query}
            />
          {/if}
          <ul class="links">
            {#each visibleLinks as link (link.url)}
              {@const saved = !!savesStore.getByUrl(link.url)}
              {@const pending = saving.has(link.url)}
              <li class="link-row">
                <a
                  class="link"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onclick={(e) => openLink(e, link)}
                >
                  <span class="title">{link.text || host(link.url)}</span>
                  {#if link.text}<span class="host">{host(link.url)}</span>{/if}
                </a>
                {#if saved}
                  <span class="saved-mark"><Icon name="check" size={14} /> Saved</span>
                {:else if !auth.isGuest}
                  <button
                    type="button"
                    class="save"
                    disabled={pending}
                    aria-label="Save {link.text || host(link.url)}"
                    onclick={() => save(link)}
                  >
                    {pending ? 'Saving…' : 'Save'}
                  </button>
                {/if}
              </li>
            {:else}
              <li class="none">No links match.</li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .saved-from-here {
    margin: 2rem 0 0;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
    font-family: var(--font-sans-serif);
  }

  .heading {
    margin: 0 0 0.5rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    min-height: 44px;
    padding: 0.5rem 0;
    border: none;
    background: none;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
    text-align: left;
    cursor: pointer;
  }

  .row:hover .title,
  .link:hover .title {
    text-decoration: underline;
  }

  .row:focus-visible,
  .links-toggle:focus-visible,
  .link:focus-visible,
  .save:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
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

  .all {
    display: inline-block;
    margin-top: 0.25rem;
    color: var(--color-primary);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .all:hover {
    text-decoration: underline;
  }

  .links-toggle {
    display: flex;
    width: fit-content;
    align-items: center;
    gap: 0.375rem;
    min-height: 44px;
    padding: 0;
    border: none;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
  }

  .links-toggle.spaced {
    margin-top: 0.5rem;
  }

  .links-toggle:hover {
    color: var(--color-text);
  }

  .count {
    font-weight: normal;
  }

  .links-panel {
    margin-top: 0.25rem;
  }

  .links-filter {
    box-sizing: border-box;
    width: 100%;
    margin-bottom: 0.5rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-md);
  }

  /* iOS Safari zooms the viewport when a focused input is smaller than 16px. */
  @media (hover: none) and (pointer: coarse) {
    .links-filter {
      font-size: 1rem;
    }
  }

  /* An article can link to hundreds of pages: the list scrolls on its own. */
  .links {
    max-height: 24rem;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .link-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .link-row:last-child {
    border-bottom: none;
  }

  .link {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    min-height: 44px;
    padding: 0.5rem 0;
    color: var(--color-text);
    font-size: var(--text-md);
    text-decoration: none;
  }

  .link .title {
    padding-top: 0.125rem;
  }

  .save {
    flex-shrink: 0;
    min-width: 4.5rem;
    min-height: 32px;
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .save:hover:not(:disabled) {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .save:disabled {
    color: var(--color-text-secondary);
    cursor: default;
  }

  .saved-mark {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    min-width: 4.5rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .none {
    padding: 0.5rem 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }
</style>
