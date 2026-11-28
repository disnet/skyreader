<script lang="ts">
  // The other versions of a paper the reader saved (its arXiv page and its PDF,
  // a journal page and its doi.org link). Under the title (`place: 'header'`),
  // one line naming them, so a reader knows before scrolling; at the end
  // (`'end'`), what was highlighted on them. Read-only: a highlight lives on the
  // version it was made in, so editing it means opening that version. Absent
  // when there's nothing to show.
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
    place: 'header' | 'end';
  }

  let { save, place }: Props = $props();

  /** Highlights shown per version before "and N more". */
  const SHOWN = 5;

  let versions = $derived(
    otherVersions(save, savesStore.articles).map((version) => ({
      version,
      highlights: highlightsOf(version),
    }))
  );
  let highlighted = $derived(versions.filter((v) => v.highlights.length > 0));

  function highlightsOf(version: SavedItem): Highlight[] {
    const byId = new Map<string, Highlight>();
    for (const key of [...savedItemLabelKeys(version), `saved:${version.rkey}`]) {
      for (const h of itemLabelsStore.getHighlights(key)) if (!byId.has(h.id)) byId.set(h.id, h);
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  // "the PDF", "the PDF and the DOI link", "the PDF, the DOI link and …".
  function separator(i: number): string {
    if (i === 0) return '';
    return i === versions.length - 1 ? ' and ' : ', ';
  }

  function suffix(n: number): string {
    return n === 0 ? '' : ` (${n} ${n === 1 ? 'highlight' : 'highlights'})`;
  }

  function href(version: SavedItem): string {
    return `/saved?read=${encodeURIComponent(savedItemDisplayKey(version))}`;
  }

  function open(e: MouseEvent, version: SavedItem) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (openKeyInReader(savedItemDisplayKey(version))) e.preventDefault();
  }
</script>

{#snippet versionLink(version: SavedItem)}
  <a href={href(version)} onclick={(e) => open(e, version)}>{versionLabel(version)}</a>
{/snippet}

{#if place === 'header' && versions.length > 0}
  <p class="other-versions-line">
    You also saved this paper as
    {#each versions as { version, highlights }, i (version.rkey)}{separator(i)}{@render versionLink(
        version
      )}{suffix(highlights.length)}{/each}.
  </p>
{:else if place === 'end' && highlighted.length > 0}
  <section class="other-versions" aria-labelledby="other-versions-heading">
    <h2 id="other-versions-heading" class="heading">Highlights on other versions</h2>
    {#each highlighted as { version, highlights } (version.rkey)}
      <div class="version">
        <p class="line">On {@render versionLink(version)}:</p>
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
      </div>
    {/each}
  </section>
{/if}

<style>
  /* Under the title: as quiet as the "From …" line beside it. */
  .other-versions-line {
    margin: 0.375rem 0 0;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .other-versions-line a {
    color: var(--color-text-secondary);
    text-decoration: underline;
    text-decoration-color: var(--color-border);
    text-underline-offset: 2px;
  }

  .other-versions-line a:hover {
    color: var(--color-primary);
    text-decoration-color: currentColor;
  }

  /* At the end: quiet, like the rest of the afterword: flat, unruled, sans. */
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
