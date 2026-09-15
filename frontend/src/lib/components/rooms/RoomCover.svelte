<script lang="ts">
  // The small square that gives a rooms row something to look at: an article's
  // cover, or — for a room — a mosaic of the covers of what's in it, so a room
  // reads as the set of things it holds rather than as another line of text.
  //
  // Deliberately a thumbnail and not a magazine cover: the rooms surfaces are
  // reading lists, and "the text is the product" (DESIGN.md). It stays a fixed
  // small square at every density, and never pushes the title off its line.
  //
  // Cover art is the least reliable thing on this page — a foreign collection
  // carries whatever metadata its curator's app happened to write, and a cover
  // URL that resolved last month can 404 today — so every level degrades:
  // covers → favicon → letter mark → icon. An image that fails to load drops
  // out of the mosaic rather than leaving a broken box behind.
  import Icon from '$lib/components/Icon.svelte';

  interface Props {
    /** Cover URLs, best first. Up to four tile into a mosaic; the rest are ignored. */
    images?: (string | null | undefined)[];
    /** The article's own site mark, shown when no cover survives. */
    faviconUrl?: string | null;
    /** Shown when neither a cover nor a favicon survives: this name's first letter. */
    label?: string | null;
  }

  let { images = [], faviconUrl = null, label = null }: Props = $props();

  // Failed URLs rather than failed indexes: the list re-sorts under us as reads
  // land, and a URL that 404s stays 404 wherever it turns up next.
  let failed = $state<string[]>([]);
  let faviconFailed = $state(false);

  let covers = $derived(
    // A collection can carry the same cover on several articles; a mosaic of
    // four copies of one image is worse than a single one.
    [...new Set(images.filter((u): u is string => Boolean(u)))]
      .filter((u) => !failed.includes(u))
      .slice(0, 4)
  );
  let showFavicon = $derived(covers.length === 0 && Boolean(faviconUrl) && !faviconFailed);
  let initial = $derived(label?.trim().slice(0, 1).toUpperCase() ?? '');
</script>

<span class="cover" data-count={covers.length}>
  {#if covers.length > 0}
    {#each covers as src (src)}
      <img {src} alt="" loading="lazy" onerror={() => (failed = [...failed, src])} />
    {/each}
  {:else if showFavicon}
    <img
      class="favicon"
      src={faviconUrl}
      alt=""
      loading="lazy"
      onerror={() => (faviconFailed = true)}
    />
  {:else if initial}
    <span class="initial" aria-hidden="true">{initial}</span>
  {:else}
    <Icon name="file-text" size={22} />
  {/if}
</span>

<style>
  .cover {
    flex-shrink: 0;
    width: var(--room-cover, 3.25rem);
    height: var(--room-cover, 3.25rem);
    border-radius: 8px;
    overflow: hidden;
    background: var(--color-bg-secondary, #f5f5f5);
    color: var(--color-text-secondary);
    /* A single cover fills the square; two or more tile the same 2x2 frame, so
       every row's thumb is the same size whatever it happens to hold. */
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 1px;
    place-items: center;
  }

  .cover[data-count='0'],
  .cover[data-count='1'] {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
  }

  /* Two covers read better as halves than as a top-heavy 2x2 with a gap. */
  .cover[data-count='2'] {
    grid-template-rows: 1fr;
  }

  /* Three: the first article leads down the left, the other two stack beside it. */
  .cover[data-count='3'] img:first-child {
    grid-row: span 2;
  }

  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* The fallbacks sit centred in the square rather than filling it — they are
     marks, not pictures. Both are sized off the square itself so they hold their
     proportion wherever a row sets --room-cover. */
  .cover .favicon {
    width: 45%;
    height: 45%;
    border-radius: 4px;
    object-fit: contain;
  }

  .initial {
    font-size: calc(var(--room-cover, 3.25rem) * 0.34);
    font-weight: var(--weight-semibold, 600);
    line-height: 1;
    color: var(--color-text-secondary);
  }
</style>
