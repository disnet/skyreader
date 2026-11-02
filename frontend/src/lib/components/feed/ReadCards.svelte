<script lang="ts">
  // Recent reads as cards: where it's from, what it is, when it was read. One
  // row that scrolls sideways, so five cards cost one line of height. Shared
  // by the end of an article and the Connect dialog, so the same reads look
  // the same in both.
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { domainFromUrl } from '$lib/utils/highlightSource';
  import { formatRelativeTime } from '$lib/utils/date';
  import type { RecentlyRead } from '$lib/services/recentlyRead.svelte';

  let {
    items,
    labelledby,
    onpick,
    wheelScroll = false,
  }: {
    items: RecentlyRead[];
    /** Id of the visible label that names the row. */
    labelledby: string;
    onpick: (item: RecentlyRead) => void;
    /** Let a plain mouse wheel scroll the row. Only inside a dialog: in the
     *  page, it would catch the wheel of a reader scrolling past. */
    wheelScroll?: boolean;
  } = $props();

  const hostOf = (url: string) => domainFromUrl(url) ?? url;

  /** The title, or the address when there's none: the host is already above it. */
  function cardTitle(item: RecentlyRead): string {
    if (item.title?.trim()) return item.title.trim();
    return item.url.replace(/^https?:\/\/(www\.)?/, '');
  }

  // A row that scrolls sideways is out of reach of a plain mouse wheel, which
  // scrolls the dialog instead. Turn the wheel sideways while the row still
  // has somewhere to go, and hand it back at either end.
  function wheelSideways(event: WheelEvent) {
    if (!wheelScroll) return;
    const row = event.currentTarget as HTMLElement;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const max = row.scrollWidth - row.clientWidth;
    if (max <= 0) return;
    if (
      (event.deltaY < 0 && row.scrollLeft <= 0) ||
      (event.deltaY > 0 && row.scrollLeft >= max - 1)
    )
      return;
    event.preventDefault();
    row.scrollLeft += event.deltaY;
  }
</script>

<ul class="read-cards" aria-labelledby={labelledby} onwheel={wheelSideways}>
  {#each items as item (item.key)}
    <li>
      <!-- Named title first: read in DOM order, every card would open on its host. -->
      <button
        type="button"
        class="read-card"
        aria-label="{cardTitle(item)}, {hostOf(item.url)}, read {formatRelativeTime(item.at)}"
        onclick={(e) => {
          // Inside an expanded card in a list, a click would also collapse it.
          e.stopPropagation();
          onpick(item);
        }}
      >
        <span class="read-card-source">
          <img class="read-card-favicon" src={getFaviconUrl(item.url)} alt="" loading="lazy" />
          <span class="read-card-host">{hostOf(item.url)}</span>
        </span>
        <span class="read-card-title">{cardTitle(item)}</span>
        <span class="read-card-when">Read {formatRelativeTime(item.at)}</span>
      </button>
    </li>
  {/each}
</ul>

<style>
  /* Flat, bordered, one row: a card says "this piece", not "this is floating". */
  .read-cards {
    list-style: none;
    display: flex;
    gap: 0.5rem;
    /* Room for the focus ring, which the scroller would otherwise clip, taken
       back with the margin so the cards still line up with the label. */
    margin: -0.25rem;
    padding: 0.25rem 0.25rem 0.5rem;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    scrollbar-width: thin;
  }

  /* Narrow enough that the next card peeks in at the edge, so the row reads
     as one that scrolls. */
  .read-cards li {
    flex: 0 0 8.75rem;
    scroll-snap-align: start;
    display: flex;
  }

  .read-card {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg);
    font: inherit;
    text-align: left;
    color: var(--color-text);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .read-card:hover {
    border-color: var(--color-primary);
    background: var(--color-bg-secondary);
  }

  .read-card:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  .read-card-source {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .read-card-favicon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    border-radius: 3px;
  }

  .read-card-host {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  /* Three lines, always reserved, so a row of cards lines up whatever the titles. */
  .read-card-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    min-height: calc(3 * 1.3em);
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .read-card-when {
    margin-top: auto;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  @media (prefers-reduced-motion: reduce) {
    .read-card {
      transition: none;
    }
  }
</style>
