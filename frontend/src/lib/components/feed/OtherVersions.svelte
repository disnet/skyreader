<script lang="ts">
  // End of a paper: the other versions of it the reader saved (its arXiv page
  // and its PDF, a journal page and its doi.org link), each with what was
  // highlighted there. Read-only here: a highlight lives on the version it was
  // made in, so editing it means opening that version. Only there when there's
  // another version.
  import { savesStore } from '$lib/stores/saves.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { otherVersions, versionLabel } from '$lib/utils/paperVersions';
  import { savedItemLabelKeys } from '$lib/utils/savedPile';
  import { savedItemDisplayKey } from '$lib/utils/dailyMagazine';
  import { openKeyInReader } from '$lib/utils/openInReader';
  import { highlightQuote } from '$lib/utils/highlightSource';
  import type { Highlight, SavedItem } from '$lib/types';

  interface Props {
    save: SavedItem;
  }

  let { save }: Props = $props();

  /** Highlights shown per version before "and N more". */
  const SHOWN = 5;

  let versions = $derived(otherVersions(save, savesStore.articles));

  function highlightsOf(version: SavedItem): Highlight[] {
    const byId = new Map<string, Highlight>();
    for (const key of [...savedItemLabelKeys(version), `saved:${version.rkey}`]) {
      for (const h of itemLabelsStore.getHighlights(key)) if (!byId.has(h.id)) byId.set(h.id, h);
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  function href(version: SavedItem): string {
    return `/saved?read=${encodeURIComponent(savedItemDisplayKey(version))}`;
  }

  function open(e: MouseEvent, version: SavedItem) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (openKeyInReader(savedItemDisplayKey(version))) e.preventDefault();
  }
</script>

{#if versions.length > 0}
  <section class="other-versions" aria-labelledby="other-versions-heading">
    <h2 id="other-versions-heading" class="heading">Other versions</h2>
    {#each versions as version (version.rkey)}
      {@const highlights = highlightsOf(version)}
      <div class="version">
        <p class="line">
          You also saved this paper as
          <a href={href(version)} onclick={(e) => open(e, version)}>{versionLabel(version)}</a
          >{#if highlights.length > 0}, with {highlights.length}
            {highlights.length === 1 ? 'highlight' : 'highlights'}{/if}.
        </p>
        {#if highlights.length > 0}
          <ul class="quotes">
            {#each highlights.slice(0, SHOWN) as highlight (highlight.id)}
              <li>
                <blockquote>{highlightQuote(highlight)}</blockquote>
                {#if highlight.note}
                  <p class="note">{highlight.note}</p>
                {/if}
              </li>
            {/each}
          </ul>
          {#if highlights.length > SHOWN}
            <a class="more" href={href(version)} onclick={(e) => open(e, version)}>
              And {highlights.length - SHOWN} more
            </a>
          {/if}
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  /* Quiet, like the rest of the afterword: flat, unruled, sans. */
  .other-versions {
    margin: 2rem 0 0;
    font-family: var(--font-sans-serif);
  }

  .heading {
    margin: 0 0 0.5rem;
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .version + .version {
    margin-top: 1rem;
  }

  .line {
    margin: 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .line a,
  .more {
    color: var(--color-primary);
    text-decoration: none;
  }

  .line a:hover,
  .more:hover {
    text-decoration: underline;
  }

  .quotes {
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
  }

  .quotes li + li {
    margin-top: 0.5rem;
  }

  blockquote {
    margin: 0;
    padding-left: 0.75rem;
    border-left: 2px solid var(--color-border);
    color: var(--color-text);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .note {
    margin: 0.25rem 0 0 0.75rem;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .more {
    display: inline-block;
    margin-top: 0.5rem;
    font-size: var(--text-sm);
  }
</style>
