<script lang="ts">
  import { tick, untrack } from 'svelte';
  import MarginNote from './MarginNote.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { MARGINALIA_ATTR } from '$lib/utils/textSelector';
  import { bracketPath, leaderPath } from '$lib/utils/marginaliaInk';
  import type { Highlight } from '$lib/types';
  import type { CommunityHighlightGroup } from '$lib/stores/communityHighlights.svelte';
  import type { useHighlights } from '$lib/hooks/useHighlights.svelte';
  import type { useCommunityHighlights } from '$lib/hooks/useCommunityHighlights.svelte';

  /**
   * The reader's marginalia: where highlights' notes live instead of in a
   * popover over the text.
   *
   * - `margin` (desktop scroll reading): your notes sit in the right margin
   *   level with their passage, tied to it by a hand-drawn bracket; every
   *   highlight gets a bracket, so a page's annotations can be scanned the way
   *   a book's can. Other readers' notes (Margin community highlights) sit in
   *   the left margin in pencil — or, where the left margin is too narrow to
   *   write in, as bare brackets that open the community popover.
   * - `gloss` (mobile, paged): there is no margin, so a note unfolds under its
   *   paragraph instead, pushing the text down rather than covering it.
   *
   * Sits inside the article's positioned wrapper; margin geometry is measured
   * from the marks themselves, relative to it.
   */
  interface Props {
    highlights: ReturnType<typeof useHighlights>;
    community: ReturnType<typeof useCommunityHighlights>;
    contentEl: () => HTMLElement | undefined;
    itemKey: () => string;
    layout: 'margin' | 'gloss';
    communityEnabled: boolean;
  }

  let { highlights, community, contentEl, itemKey, layout, communityEnabled }: Props = $props();

  interface Span {
    top: number;
    bottom: number;
  }
  interface OwnItem extends Span {
    id: string;
    highlight: Highlight;
  }
  interface CommunityItem extends Span {
    id: string;
    group: CommunityHighlightGroup;
  }

  // Layout constants (px). The bracket gutter sits between the text and the
  // notes; brackets that overlap vertically step outward into lanes.
  const GUTTER = 14;
  const LANE = 6;
  const NOTE_INSET = 40;
  const STACK_GAP = 14;
  const EDGE = 24;
  const MIN_RAIL = 150;
  /** Room the ghost "add a note" takes, and so its hover target. */
  const GHOST_WIDTH = 120;

  let rootEl = $state<HTMLElement | null>(null);
  let rootHeight = $state(0);
  let own = $state<OwnItem[]>([]);
  let comm = $state<CommunityItem[]>([]);
  let rightSpace = $state(0);
  let leftSpace = $state(0);
  let heights = $state<Record<string, number>>({});

  // ── Measurement ──────────────────────────────────────────────────
  function spansFor(body: HTMLElement, selector: string, key: string, origin: DOMRect) {
    const spans = new Map<string, Span>();
    for (const mark of body.querySelectorAll<HTMLElement>(selector)) {
      const id = mark.dataset[key];
      if (!id) continue;
      for (const rect of mark.getClientRects()) {
        if (!rect.width && !rect.height) continue;
        const top = rect.top - origin.top;
        const bottom = rect.bottom - origin.top;
        const span = spans.get(id);
        if (!span) spans.set(id, { top, bottom });
        else {
          span.top = Math.min(span.top, top);
          span.bottom = Math.max(span.bottom, bottom);
        }
      }
    }
    return spans;
  }

  function measure() {
    const body = contentEl();
    const root = rootEl;
    if (!body || !root || layout !== 'margin') return;
    const origin = root.getBoundingClientRect();
    rightSpace = window.innerWidth - origin.right;
    leftSpace = origin.left;

    const ownSpans = spansFor(body, 'mark.highlight[data-highlight-id]', 'highlightId', origin);
    own = itemLabelsStore
      .getHighlights(itemKey())
      .flatMap((highlight) => {
        const span = ownSpans.get(highlight.id);
        return span ? [{ id: highlight.id, highlight, ...span }] : [];
      })
      .sort((a, b) => a.top - b.top);

    if (!communityEnabled) {
      comm = [];
      return;
    }
    const commSpans = spansFor(body, 'mark.community-highlight', 'communityId', origin);
    comm = community.groups
      .flatMap((group) => {
        const span = commSpans.get(group.id);
        return span ? [{ id: group.id, group, ...span }] : [];
      })
      .sort((a, b) => a.top - b.top);
  }

  let measureRaf: number | null = null;
  function schedule() {
    if (measureRaf != null) return;
    measureRaf = requestAnimationFrame(() => {
      measureRaf = null;
      measure();
    });
  }

  // Re-measure whenever the marks are re-drawn…
  $effect(() => {
    void highlights.marksVersion;
    void community.version;
    void layout;
    void communityEnabled;
    schedule();
  });

  // …and whenever anything reflows the text under them: width, type size,
  // images and embeds settling, the web font arriving.
  $effect(() => {
    const body = contentEl();
    if (!body || layout !== 'margin') return;
    const ro = new ResizeObserver(schedule);
    ro.observe(body);
    window.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      document.fonts?.removeEventListener('loadingdone', schedule);
      if (measureRaf != null) cancelAnimationFrame(measureRaf);
      measureRaf = null;
    };
  });

  // ── Margin layout ─────────────────────────────────────────────────
  const rightRail = $derived(Math.min(240, rightSpace - NOTE_INSET - EDGE));
  const leftRail = $derived(Math.min(220, leftSpace - NOTE_INSET - EDGE));
  const leftWritable = $derived(leftRail >= MIN_RAIL);

  /** Brackets that overlap vertically step outward, one lane each. */
  function lanes<T extends Span>(items: T[]): number[] {
    const laneBottoms: number[] = [];
    return items.map((item) => {
      let lane = laneBottoms.findIndex((bottom) => bottom < item.top - 2);
      if (lane === -1) lane = laneBottoms.length;
      laneBottoms[lane] = item.bottom;
      return Math.min(lane, 2);
    });
  }

  /**
   * Notes sit level with the first line of their passage; when the note above
   * runs long, the next one is pushed down just enough to clear it and a
   * pencil leader ties it back to its bracket.
   */
  function stack<T extends Span & { id: string }>(items: T[]): Map<string, number> {
    const placed = new Map<string, number>();
    let cursor = -Infinity;
    for (const item of items) {
      const y = Math.max(item.top - 2, cursor + STACK_GAP);
      placed.set(item.id, y);
      cursor = y + (heights[item.id] ?? 40);
    }
    return placed;
  }

  const ownLanes = $derived(lanes(own));
  const writtenOwn = $derived(
    own.filter((item) => !!item.highlight.note?.trim() || highlights.editingId === item.id)
  );
  const ownY = $derived(stack(writtenOwn));
  const commLanes = $derived(lanes(comm));
  const writtenComm = $derived(
    leftWritable ? comm.filter((item) => item.group.people.some((p) => p.note)) : []
  );
  const commY = $derived(stack(writtenComm));

  function firstNote(group: CommunityHighlightGroup) {
    return group.people.find((p) => p.note) ?? group.people[0];
  }

  function names(group: CommunityHighlightGroup): string {
    const all = group.people.map((p) => p.displayName || p.handle || 'A reader');
    return all.length > 2 ? `${all.slice(0, 2).join(', ')} +${all.length - 2}` : all.join(', ');
  }

  // ── Gloss layout ──────────────────────────────────────────────────
  // The open gloss is drawn into a host element inserted right after the
  // passage's note marker (or its last mark), splitting the paragraph there:
  // a long paragraph shouldn't push the note a screen away from the passage
  // it's about. The host is a block inside the paragraph, so the text simply
  // resumes on the line below it. It is marked `data-marginalia`, so the
  // highlight machinery never reads its text as the article's.
  let glossHost = $state<HTMLElement | null>(null);

  /** Where a gloss can't sit mid-block, it goes after the whole block. */
  const UNSPLITTABLE = 'pre, table, h1, h2, h3, h4, h5, h6';

  /** The element the gloss goes right after, or null if the passage is gone. */
  function glossAnchor(body: HTMLElement, id: string): HTMLElement | null {
    const escaped = CSS.escape(id);
    const marks = body.querySelectorAll<HTMLElement>(
      `mark.highlight[data-highlight-id="${escaped}"]`
    );
    const marker = body.querySelector<HTMLElement>(
      `.highlight-note-marker[data-highlight-id="${escaped}"]`
    );
    let anchor: HTMLElement | null = marker ?? marks[marks.length - 1] ?? null;
    if (!anchor) return null;
    // Never inside a link (tapping the note would follow it) or a block that
    // can't take a note mid-way; step out to after it instead.
    const link = anchor.closest('a');
    if (link && body.contains(link)) anchor = link;
    const rigid = anchor.closest<HTMLElement>(UNSPLITTABLE);
    if (rigid && body.contains(rigid)) {
      anchor = rigid;
      while (anchor.parentElement && anchor.parentElement !== body) anchor = anchor.parentElement;
    }
    return anchor;
  }

  /** Put the host right after its anchor, touching the DOM only if it moved. */
  function placeGloss(host: HTMLElement, body: HTMLElement, id: string) {
    const anchor = glossAnchor(body, id);
    if (!anchor) host.remove();
    else if (anchor.nextSibling !== host) anchor.after(host);
  }

  // One host per open gloss. Redrawing the marks (saving the note, publishing
  // it) leaves the host where it is — the marks are rebuilt around it — so the
  // note isn't torn down and unfolded again, or blurred mid-edit, each time.
  $effect(() => {
    const id = highlights.glossId;
    const body = contentEl();
    if (layout !== 'gloss' || !id || !body) {
      glossHost = null;
      return;
    }
    const host = document.createElement('div');
    host.setAttribute(MARGINALIA_ATTR, '');
    host.className = 'marginalia-gloss-host';
    placeGloss(host, body, id);
    glossHost = host;
    return () => {
      const parent = host.parentNode;
      host.remove();
      // Rejoin the text the host split, so the paragraph is as it was.
      parent?.normalize();
    };
  });

  // …and follows its passage if a redraw does move it.
  $effect(() => {
    void highlights.marksVersion;
    const host = glossHost;
    const body = contentEl();
    const id = untrack(() => highlights.glossId);
    if (host && body && id) placeGloss(host, body, id);
  });

  const glossHighlight = $derived.by(() => {
    void highlights.marksVersion;
    const id = highlights.glossId;
    return id ? itemLabelsStore.getHighlights(itemKey()).find((h) => h.id === id) : undefined;
  });

  function portal(node: HTMLElement, target: HTMLElement) {
    target.appendChild(node);
    // Bring a freshly unfolded note into view if it opened below the fold.
    void tick().then(() => node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return {
      destroy() {
        node.remove();
      },
    };
  }

  // ── Shared note wiring ────────────────────────────────────────────
  function noteProps(highlight: Highlight) {
    const id = highlight.id;
    return {
      highlight,
      editing: highlights.editingId === id,
      active: highlights.activeId === id,
      onEdit: () => highlights.openNote(id),
      onSave: (note: string) => highlights.saveNote(id, note),
      onClose: () => highlights.closeNote(),
      onRemove: () => highlights.removeHighlightWithUndo(id),
      onPublish: highlights.publishToMargin ? () => highlights.publishToMargin?.(id) : undefined,
      onUnpublish: highlights.unpublishFromMargin
        ? () => highlights.unpublishFromMargin?.(id)
        : undefined,
      onHover: (on: boolean) => highlights.setActive(on ? id : null),
    };
  }
</script>

<div class="marginalia" bind:this={rootEl} bind:clientHeight={rootHeight}>
  {#if layout === 'margin' && rightRail >= MIN_RAIL - 40}
    <aside
      class="rail rail-right"
      aria-label="Your highlights and notes"
      style:--rail={`${rightRail}px`}
    >
      <svg class="rail-ink" width={rightRail + NOTE_INSET} height={rootHeight} aria-hidden="true">
        {#each own as item, i (item.id)}
          {@const x = GUTTER + ownLanes[i] * LANE}
          {@const h = item.bottom - item.top + 4}
          {@const written = !!item.highlight.note?.trim()}
          {@const active = highlights.activeId === item.id || highlights.editingId === item.id}
          <g class="bracket" class:written class:active transform="translate({x} {item.top - 2})">
            <path d={bracketPath(item.id, h)} />
            {#if ownY.has(item.id) && ownY.get(item.id)! - (item.top - 2) > 8}
              {@const beakX = h < 34 ? 6 : 8.4}
              <path
                class="leader"
                transform="translate({beakX} {h / 2})"
                d={leaderPath(
                  item.id,
                  NOTE_INSET - x - beakX - 4,
                  ownY.get(item.id)! - (item.top - 2) - h / 2 + 11
                )}
              />
            {/if}
          </g>
        {/each}
      </svg>

      {#each own as item, i (item.id)}
        {@const written = !!item.highlight.note?.trim()}
        {@const editing = highlights.editingId === item.id}
        {@const left = GUTTER + ownLanes[i] * LANE - 6}
        <!-- Unwritten, the hit area reaches past the bracket over the ghost
             "add a note" so the invitation holds as the pointer drifts to it. -->
        <button
          class="bracket-hit"
          class:written
          class:lit={!written && !editing && highlights.activeId === item.id}
          style:top={`${item.top - (written ? 4 : 8)}px`}
          style:height={`${item.bottom - item.top + (written ? 8 : 16)}px`}
          style:left={`${left}px`}
          style:width={written || editing ? undefined : `${NOTE_INSET - left + GHOST_WIDTH}px`}
          tabindex={written ? -1 : 0}
          aria-label={written ? 'Edit note' : 'Add a note'}
          onclick={() => highlights.openNote(item.id)}
          onmouseenter={() => highlights.setActive(item.id)}
          onmouseleave={() => highlights.setActive(null)}
        >
          {#if !written && !editing}
            <span class="ghost" style:left={`${NOTE_INSET - left}px`} aria-hidden="true"
              >add a note</span
            >
          {/if}
        </button>
      {/each}

      {#each writtenOwn as item (item.id)}
        <div
          class="rail-slot"
          style:top={`${ownY.get(item.id) ?? item.top}px`}
          bind:offsetHeight={heights[item.id]}
        >
          <MarginNote variant="margin" {...noteProps(item.highlight)} />
        </div>
      {/each}
    </aside>

    {#if comm.length > 0}
      <aside
        class="rail rail-left"
        class:ticks-only={!leftWritable}
        aria-label="Other readers' highlights"
        style:--rail={`${Math.max(leftRail, 0)}px`}
      >
        <svg
          class="rail-ink"
          width={Math.max(leftRail, 0) + NOTE_INSET}
          height={rootHeight}
          aria-hidden="true"
        >
          {#each comm as item, i (item.id)}
            {@const h = item.bottom - item.top + 4}
            <g
              class="bracket pencil"
              transform="translate({Math.max(leftRail, 0) +
                NOTE_INSET -
                GUTTER -
                commLanes[i] * LANE} {item.top - 2}) scale(-1 1)"
            >
              <path d={bracketPath(`c:${item.id}`, h)} />
            </g>
          {/each}
        </svg>
        {#each comm as item, i (item.id)}
          <button
            class="bracket-hit pencil"
            style:top={`${item.top - 4}px`}
            style:height={`${item.bottom - item.top + 8}px`}
            style:right={`${GUTTER + commLanes[i] * LANE - 6}px`}
            aria-label="Highlighted by {names(item.group)}"
            onclick={(e) => community.open(item.id, e.currentTarget)}
            onmouseenter={() => community.setActive(item.id)}
            onmouseleave={() => community.setActive(null)}
          ></button>
        {/each}
        {#each writtenComm as item (item.id)}
          {@const person = firstNote(item.group)}
          <div
            class="rail-slot"
            style:top={`${commY.get(item.id) ?? item.top}px`}
            bind:offsetHeight={heights[item.id]}
          >
            <button
              class="community-note"
              onclick={(e) => community.open(item.id, e.currentTarget)}
              onmouseenter={() => community.setActive(item.id)}
              onmouseleave={() => community.setActive(null)}
            >
              <span class="community-text">{person?.note}</span>
              <span class="community-by">{names(item.group)}</span>
            </button>
          </div>
        {/each}
      </aside>
    {/if}
  {/if}
</div>

{#if layout === 'gloss' && glossHost && glossHighlight}
  {#key glossHost}
    <div class="gloss-slot" use:portal={glossHost}>
      <MarginNote
        variant="gloss"
        {...noteProps(glossHighlight)}
        onClose={() => {
          highlights.closeNote();
          // Closing an editor that ended empty folds the gloss away too; there
          // is nothing left to show under the paragraph.
          if (!glossHighlight?.note?.trim()) highlights.toggleGloss(glossHighlight.id);
        }}
        onFold={() => highlights.toggleGloss(glossHighlight.id)}
      />
    </div>
  {/key}
{/if}

<style>
  /* Covers the article column exactly; the rails hang off its sides. */
  .marginalia {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .rail {
    position: absolute;
    top: 0;
    bottom: 0;
    width: calc(var(--rail) + 40px);
  }

  .rail-right {
    left: 100%;
  }

  .rail-left {
    right: 100%;
  }

  .rail-ink {
    position: absolute;
    top: 0;
    left: 0;
    overflow: visible;
    pointer-events: none;
  }

  .rail-right .rail-ink {
    left: 0;
  }

  .rail-left .rail-ink {
    left: auto;
    right: 0;
  }

  /* Hand-drawn brackets. A highlight with a note gets ink; a bare one gets a
     fainter stroke of the same pen. */
  .bracket path {
    fill: none;
    stroke: var(--ink-note-soft);
    stroke-width: 1.35;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.75;
    transition:
      opacity 0.18s ease,
      stroke 0.18s ease;
  }

  .bracket.written path {
    stroke: var(--ink-note);
    opacity: 0.6;
  }

  .bracket.active path {
    stroke: var(--ink-note);
    opacity: 1;
  }

  .bracket path.leader {
    stroke-width: 1;
    stroke-dasharray: 1 3.2;
    opacity: 0.8;
  }

  .bracket.pencil path {
    stroke: var(--ink-pencil-soft);
    opacity: 1;
  }

  /* An invisible strip over each bracket: click it to write. */
  .bracket-hit {
    position: absolute;
    width: 22px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: none;
    cursor: pointer;
    pointer-events: auto;
  }

  .bracket-hit:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }

  .ghost {
    position: absolute;
    top: 6px;
    font-family: var(--font-hand);
    font-size: calc(var(--article-font-size, 1.125rem) * 0.86);
    line-height: 1.3;
    color: var(--ink-note-soft);
    opacity: 0;
    transform: translateX(-3px);
    transition:
      opacity 0.18s ease,
      transform 0.18s ease;
    pointer-events: none;
    white-space: nowrap;
  }

  .bracket-hit:hover .ghost,
  .bracket-hit:focus-visible .ghost,
  .bracket-hit.lit .ghost {
    opacity: 1;
    transform: none;
  }

  .rail-slot {
    position: absolute;
    width: var(--rail);
    pointer-events: auto;
    transition: top 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .rail-right .rail-slot {
    left: 40px;
  }

  .rail-left .rail-slot {
    right: 40px;
    text-align: right;
  }

  /* Another reader's note: the same kind of mark in someone else's pencil,
     signed in small type the way a borrowed book's margins are. */
  .community-note {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.2rem;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    text-align: right;
    color: var(--ink-pencil);
    cursor: pointer;
    opacity: 0.85;
    transition: opacity 0.18s ease;
  }

  .community-note:hover,
  .community-note:focus-visible {
    opacity: 1;
  }

  .community-note:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
    border-radius: 2px;
  }

  .community-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    overflow: hidden;
    font-family: var(--font-hand);
    font-size: calc(var(--article-font-size, 1.125rem) * 0.84);
    line-height: 1.3;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .community-by {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-sans-serif);
    font-size: var(--text-2xs);
    letter-spacing: 0.01em;
    color: var(--color-text-secondary);
  }

  .gloss-slot {
    display: block;
  }

  @media (prefers-reduced-motion: reduce) {
    .bracket path,
    .ghost,
    .rail-slot,
    .community-note {
      transition: none;
    }
  }
</style>
