<script lang="ts">
  // End of an article: the links the reader saved out of it, so a reading
  // session's trail can be picked up from where it started. Quiet, and only
  // there when there's something in it.
  import { savesStore } from '$lib/stores/saves.svelte';
  import { savesFrom, savedFromLibraryHref } from '$lib/utils/savedFrom';
  import { savedItemDisplayKey } from '$lib/utils/dailyMagazine';
  import { openKeyInReader } from '$lib/utils/openInReader';
  import { decodeEntities } from '$lib/utils/entities';
  import type { SavedItem } from '$lib/types';

  interface Props {
    /** The open article's link. */
    url: string | null | undefined;
  }

  let { url }: Props = $props();

  /** Enough to pick up the trail; the Library holds the rest. */
  const SHOWN = 5;

  let saves = $derived(savesFrom(savesStore.articles, url));
  let shown = $derived(saves.slice(0, SHOWN));

  function label(save: SavedItem): string {
    return decodeEntities(save.title ?? '') || host(save) || save.url;
  }

  function host(save: SavedItem): string {
    if (save.domain) return save.domain;
    try {
      return new URL(save.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function open(save: SavedItem) {
    if (!openKeyInReader(savedItemDisplayKey(save))) {
      window.open(save.url, '_blank', 'noopener');
    }
  }
</script>

{#if url && saves.length > 0}
  <section class="saved-from-here" aria-labelledby="saved-from-here-heading">
    <h2 id="saved-from-here-heading" class="heading">
      {saves.length === 1
        ? 'A link you saved from this'
        : `${saves.length} links you saved from this`}
    </h2>
    <ul>
      {#each shown as save (save.rkey)}
        <li>
          <button type="button" class="row" onclick={() => open(save)}>
            <span class="title">{label(save)}</span>
            {#if save.title && host(save)}
              <span class="host">{host(save)}</span>
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
    font-weight: var(--weight-medium, 500);
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

  .row:hover .title {
    text-decoration: underline;
  }

  .row:focus-visible {
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
</style>
