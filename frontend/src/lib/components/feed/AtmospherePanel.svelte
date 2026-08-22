<script lang="ts">
  // PURE presentational Atmosphere panel: the shared note box + the lane tab strip
  // + the expanded lane's people. Renders entirely from props — no stores, no
  // fetching — so it drops into any surface (the feed card's sticky footer, the
  // reader's Discussion drawer) given a resolved laneRow and handlers. The data
  // wiring lives in useAtmosphere (the container/host owns it).
  //
  // Two independent regions:
  //  • the note lead — shown whenever the item is shared, the Discussion lead.
  //  • the lanes (tabs + expanded panel) — shown when `lanesOpen`.
  // Both are root-level (no wrapper) so the host's flex-column layout sees them as
  // direct children, exactly as when this markup lived inline in the card.
  import Icon from '$lib/components/Icon.svelte';
  import { safeHref } from '$lib/utils/sanitize';
  import { noteToBlocks } from '$lib/utils/shareNote';
  import type { Snippet } from 'svelte';
  import type { LaneId, LaneRowVM, ExpandedLaneItemsVM } from '../articleCardView.types';

  let {
    laneRow = [],
    expandedLane = null,
    expandedLaneItems,
    currentlyShared = false,
    currentNote,
    /** Render the lane tabs + expanded panel. The note lead is independent of this. */
    lanesOpen = true,
    /** Optional DOM id for the lanes region (so a toggle can aria-control it). */
    panelId,
    /** Optional content slotted between the note lead and the lanes (when shared). */
    leadExtra,
    onToggleLane,
    onCreateInLane,
    onEditShare,
    onOpenAuthor,
  }: {
    laneRow?: LaneRowVM[];
    expandedLane?: LaneId | null;
    expandedLaneItems?: ExpandedLaneItemsVM;
    currentlyShared?: boolean;
    currentNote?: string;
    lanesOpen?: boolean;
    panelId?: string;
    leadExtra?: Snippet;
    onToggleLane?: (id: LaneId) => void;
    onCreateInLane?: (id: LaneId) => void;
    /** Open the share composer to edit the posted note. */
    onEditShare?: () => void;
    onOpenAuthor?: (did: string) => void;
  } = $props();

  // The posted note as display blocks: quotes get the gold quotation rule, so
  // the note reads here exactly as it does on the linkblog — no `> ` Markdown.
  let noteBlocks = $derived(
    currentNote ? noteToBlocks(currentNote).filter((b) => b.text.trim()) : []
  );
</script>

{#if currentlyShared}
  <!-- Your posted note, read-only: editing happens in the share composer (the
       Edit affordance), so the note here is a record, not a form. -->
  <div class="atmosphere-lead">
    <div class="share-note" class:empty={noteBlocks.length === 0}>
      {#if noteBlocks.length > 0}
        <div class="share-note-body">
          {#each noteBlocks as block, i (i)}
            {#if block.kind === 'quote'}
              <p class="share-note-quote">{block.text}</p>
            {:else}
              <p class="share-note-text">{block.text}</p>
            {/if}
          {/each}
        </div>
      {:else}
        <span class="share-note-placeholder">Shared without a note.</span>
      {/if}
      <button
        type="button"
        class="share-note-edit"
        onclick={(e) => {
          e.stopPropagation();
          onEditShare?.();
        }}
      >
        <Icon name="edit" size={14} />
        <span>{noteBlocks.length > 0 ? 'Edit note' : 'Add a note'}</span>
      </button>
    </div>
  </div>
  <!-- Host-supplied affordance (e.g. Remove) sitting under your note, above the
       wider discussion. -->
  {@render leadExtra?.()}
{/if}
{#if lanesOpen && laneRow.length > 0}
  <div class="atmosphere-panel" id={panelId} role="region" aria-label="Discussion">
    <!-- Lanes as a tab strip: each lane is a select-toggle chip carrying its
         count, paired with its own [+] create. Picking a tab reveals that lane's
         posts in the panel below; picking the active tab again closes it. One lane
         open at a time (the active tab). -->
    <div class="lane-tabs" role="tablist">
      {#each laneRow as row (row.id)}
        {@const isActive = expandedLane === row.id}
        {@const expandable = row.count > 0}
        <div class="lane-tab" class:active={isActive} class:mine={row.isMine}>
          <button
            type="button"
            class="lane-tab-main"
            role="tab"
            aria-selected={isActive}
            disabled={!expandable}
            title={row.title}
            onclick={(e) => {
              e.stopPropagation();
              onToggleLane?.(row.id);
            }}
          >
            <span class="lane-tab-icon"><Icon name={row.icon} size={15} /></span>
            <span class="lane-tab-label">{row.label}</span>
            <span class="lane-tab-count">{row.count}{row.capped ? '+' : ''}</span>
          </button>

          {#if row.canCreate}
            <button
              type="button"
              class="lane-tab-create"
              class:done={row.createIsEdit}
              title={row.createLabel}
              aria-label={row.createLabel}
              onclick={(e) => {
                e.stopPropagation();
                onCreateInLane?.(row.id);
              }}
            >
              <Icon name={row.createIsEdit ? 'edit' : 'plus'} size={14} />
            </button>
          {/if}
        </div>
      {/each}
    </div>

    {#if expandedLane}
      {@const activeRow = laneRow.find((r) => r.id === expandedLane)}
      {#if activeRow}
        <div class="lane-panel" role="tabpanel">
          {#if expandedLaneItems?.loading}
            <div class="lane-status">Loading…</div>
          {:else if expandedLaneItems && expandedLaneItems.entries.length > 0}
            {#if expandedLane === 'semble'}
              <!-- Saves aren't notes — show them as a wrapping flow of
                   "<who> saved to <collection>" units rather than a list. -->
              <div class="lane-saves">
                {#each expandedLaneItems.entries as entry (entry.did)}
                  {@const who = '@' + (entry.handle ?? entry.did.slice(0, 18))}
                  {#if entry.collections?.length}
                    {#each entry.collections as col (col.name + (col.url ?? ''))}
                      <span class="lane-save">
                        <button
                          type="button"
                          class="lane-save-handle"
                          onclick={(e) => {
                            e.stopPropagation();
                            onOpenAuthor?.(entry.did);
                          }}>{who}</button
                        >
                        <span class="lane-save-verb">saved to</span>
                        {#if col.url}
                          <a
                            class="lane-save-collection"
                            href={col.url}
                            target="_blank"
                            rel="noopener"
                            title="Open “{col.name}” on Semble"
                            onclick={(e) => e.stopPropagation()}
                            ><Icon name="folder" size={11} />{col.name}</a
                          >
                        {:else}
                          <span class="lane-save-collection"
                            ><Icon name="folder" size={11} />{col.name}</span
                          >
                        {/if}
                      </span>
                    {/each}
                  {:else}
                    <span class="lane-save">
                      <button
                        type="button"
                        class="lane-save-handle"
                        onclick={(e) => {
                          e.stopPropagation();
                          onOpenAuthor?.(entry.did);
                        }}>{who}</button
                      >
                      <span class="lane-save-verb">saved this</span>
                    </span>
                  {/if}
                {/each}
              </div>
            {:else if expandedLane === 'margin'}
              <!-- Annotations, not bare links: each is its own card with the
                   motivation verb and the highlighted passage / comment. -->
              <div class="lane-annotations">
                {#each expandedLaneItems.entries as entry (entry.did + (entry.url ?? ''))}
                  <div class="lane-annotation">
                    <div class="lane-annotation-head">
                      <button
                        type="button"
                        class="lane-save-handle"
                        onclick={(e) => {
                          e.stopPropagation();
                          onOpenAuthor?.(entry.did);
                        }}>@{entry.handle ?? entry.did.slice(0, 18)}</button
                      >
                      <span class="lane-save-verb">{entry.verb ?? 'annotated'}</span>
                    </div>
                    {#if entry.quote}
                      <p class="lane-annotation-quote">{entry.quote}</p>
                    {/if}
                    {#if entry.note}
                      <p class="lane-annotation-comment">{entry.note}</p>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <ul class="lane-people">
                {#each expandedLaneItems.entries as entry (entry.did + (entry.url ?? ''))}
                  <li class="lane-person">
                    <div class="lane-person-row">
                      <button
                        type="button"
                        class="lane-person-handle"
                        onclick={(e) => {
                          e.stopPropagation();
                          onOpenAuthor?.(entry.did);
                        }}>@{entry.handle ?? entry.did.slice(0, 18)}</button
                      >
                      {#if entry.url}
                        <a
                          class="lane-person-link"
                          href={safeHref(entry.url)}
                          target="_blank"
                          rel="noopener"
                          title="Open {activeRow.label}"
                          onclick={(e) => e.stopPropagation()}
                          ><Icon name="external-link" size={13} /></a
                        >
                      {/if}
                    </div>
                    {#if entry.note}<p class="lane-person-note">{entry.note}</p>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          {:else if !expandedLaneItems?.loading}
            <div class="lane-status">Nothing here yet.</div>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .atmosphere-panel {
    display: flex;
    flex-direction: column;
  }

  /* Your posted note, the Discussion area's lead once shared. A fixed slot
     (min-height) keeps its metrics constant whether or not a lane is expanded
     below, so the note never shifts; it grows past the floor once it wraps. */
  .atmosphere-lead {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 3.25rem;
    padding: 0.5rem 0;
    text-align: left;
  }

  .share-note {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .share-note.empty {
    align-items: center;
  }

  .share-note-body {
    flex: 1;
    min-width: 0;
    /* Long notes stay in their lane: cap and scroll rather than swallowing the
       card. Comfortable measure for short commentary. */
    max-height: 10rem;
    max-width: 60ch;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .share-note-text,
  .share-note-quote {
    margin: 0 0 0.375rem;
    font-size: var(--text-lg);
    line-height: var(--leading-normal);
    color: var(--color-text);
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .share-note-text:last-child,
  .share-note-quote:last-child {
    margin-bottom: 0;
  }

  /* The gold quotation rule — same convention as the composer and the
     highlights page: a quotation mark, not a status accent. */
  .share-note-quote {
    padding-left: 0.75rem;
    border-left: 3px solid color-mix(in srgb, #f5c518 70%, transparent);
    color: var(--color-text-secondary);
  }

  .share-note-placeholder {
    flex: 1;
    min-width: 0;
    font-size: var(--text-md);
    color: var(--color-text-secondary);
  }

  .share-note-edit {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.625rem;
    background: none;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 6px;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      color 0.15s,
      border-color 0.15s;
  }

  .share-note-edit:hover {
    border-color: var(--color-primary, #0066cc);
    color: var(--color-primary, #0066cc);
  }

  /* Tab strip: lanes laid out horizontally, wrapping on narrow cards. Each tab
     is a select-toggle chip fused to its own [+] create, split by a divider so
     the one chip reads as two actions. */
  .lane-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    padding: 0.625rem 0;
  }

  .lane-tab {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 6px;
    overflow: hidden;
    transition: border-color 0.15s ease;
  }

  .lane-tab.active {
    border-color: var(--color-primary);
  }

  .lane-tab-main {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.5rem;
    background: none;
    border: none;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text);
    cursor: pointer;
    transition:
      color 0.15s ease,
      background-color 0.15s ease;
  }

  .lane-tab-main:hover:not(:disabled) {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  /* A countless lane has nothing to reveal — its tab is disabled, but the count
     still shows (quietly) and the [+] create stays live. */
  .lane-tab-main:disabled {
    cursor: default;
  }

  .lane-tab.active .lane-tab-main {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .lane-tab-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .lane-tab.active .lane-tab-icon,
  .lane-tab.mine .lane-tab-icon {
    color: var(--color-primary);
  }

  .lane-tab-label {
    white-space: nowrap;
  }

  .lane-tab-count {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
  }

  .lane-tab.active .lane-tab-count {
    color: var(--color-primary);
  }

  /* On narrow cards the tab collapses to its icon + count — the label drops out
     (the icon carries the lane, the title attr the name), but the count stays so
     the discussion volume reads at a glance. The [+] create is already icon-only. */
  @media (max-width: 30rem) {
    .lane-tab-label {
      display: none;
    }
  }

  .lane-tab-create {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.4375rem;
    background: none;
    border: none;
    border-left: 1px solid var(--color-border, #e0e0e0);
    color: var(--color-primary, #0066cc);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .lane-tab.active .lane-tab-create {
    border-left-color: var(--color-primary);
  }

  .lane-tab-create:hover {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.08));
  }

  .lane-tab-create.done {
    color: var(--color-text-secondary);
  }

  /* The selected tab's posts: scrolls if long. */
  .lane-panel {
    max-height: min(45vh, 16rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.25rem 0 0.75rem;
  }

  .lane-status {
    padding: 0.125rem 0 0.5rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .lane-people {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .lane-person {
    min-width: 0;
  }

  .lane-person-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .lane-person-handle {
    min-width: 0;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lane-person-handle:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .lane-person-link {
    flex-shrink: 0;
    display: inline-flex;
    color: var(--color-text-secondary);
  }

  .lane-person-link:hover {
    color: var(--color-primary);
  }

  .lane-person-note {
    margin: 0.125rem 0 0;
    font-size: var(--text-sm);
    line-height: 1.45;
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Semble lane: saves aren't notes, so they read as a wrapping flow of
     "<who> saved to <collection>" chips — each on its own subtle fill to set it
     apart — rather than the per-person note list. */
  .lane-saves {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0 0 0.5rem;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .lane-save {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    max-width: 100%;
    padding: 0.1875rem 0.5rem;
    background: var(--color-bg-secondary);
    border-radius: 0.5rem;
  }

  .lane-save-handle {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-weight: var(--weight-semibold);
    color: var(--color-text);
    cursor: pointer;
    white-space: nowrap;
  }

  .lane-save-handle:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .lane-save-verb {
    color: var(--color-text-secondary);
  }

  .lane-save-collection {
    font-weight: var(--weight-medium);
    color: var(--color-text);
    text-decoration: none;
    white-space: nowrap;
  }

  .lane-save-collection :global(.icon) {
    vertical-align: -1px;
    margin-right: 0.1875rem;
    opacity: 0.7;
  }

  a.lane-save-collection:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  a.lane-save-collection:hover :global(.icon) {
    opacity: 1;
  }

  /* margin.at lane: each annotation is its own subtly-filled card — a
     "<who> <motivation>" head, then the highlighted passage and/or comment. */
  .lane-annotations {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0 0 0.5rem;
  }

  .lane-annotation {
    padding: 0.4375rem 0.5rem;
    background: var(--color-bg-secondary);
    border-radius: 0.5rem;
    font-size: var(--text-sm);
    line-height: 1.45;
  }

  .lane-annotation-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem;
  }

  .lane-annotation-quote {
    margin: 0.3125rem 0 0;
    padding-left: 0.5rem;
    border-left: 2px solid var(--color-border);
    color: var(--color-text);
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .lane-annotation-comment {
    margin: 0.3125rem 0 0;
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
