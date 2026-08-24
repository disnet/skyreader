<script lang="ts">
  // PURE presentational discussion panel: one merged stream of what the
  // Atmosphere said about this article, a filter row over it, and the ways to
  // add your own. Renders entirely from props — no stores, no fetching — so it
  // drops into any surface (the feed card's sticky footer, the reader's
  // Discussion section) given a resolved stream and handlers. The data wiring
  // lives in useAtmosphere (the container/host owns it).
  //
  // <!--
  // THESIS: an article's discussion is ONE conversation that happens to be
  //   spread across four networks. It refuses the tab strip that made the reader
  //   click through four bordered boxes — two of them empty — to find out what
  //   anyone said, and refuses the handle-over-content list that came with it.
  // OWN-WORLD: the app's own reading-room system, at list density: flat,
  //   borderless rows separated by rhythm, one interaction blue, pill filters on
  //   the sunken tone, hairline rules. The only new material is the person —
  //   a 30px avatar wearing a small source glyph.
  // STORY: the reader finishes an article, sees who else read it and what they
  //   said, in order, and can answer in the network of their choosing.
  // FIRST VIEWPORT: heading and total, then filter pills, then the stream —
  //   avatar left, name and time on the head line, the person's words beneath in
  //   ink. The ways to add yours sit below a hairline at the end, where a reply
  //   belongs.
  // FORM: chronological conversation list; an extension of the established
  //   surface, so no new visual world.
  // -->
  //
  // Your own posted note is NOT rendered here: the Share control carries the
  // shared state and opens the composer on it. This panel is other people's side
  // of the discussion.
  import type { Snippet } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { safeHref } from '$lib/utils/sanitize';
  import type {
    LaneId,
    LaneRowVM,
    DiscussionEntryVM,
    DiscussionFilterId,
    DiscussionFilterVM,
    DiscussionStreamVM,
    SembleContextVM,
  } from '../articleCardView.types';

  let {
    laneRow = [],
    filters = [],
    activeFilter = 'all',
    stream = { idle: true, loading: false, entries: [] },
    sembleContext,
    /** Render the discussion at all. */
    lanesOpen = true,
    /** Optional DOM id for the region (so a toggle can aria-control it). */
    panelId,
    /** The reader frames the section with a heading; the card's own Discussion
        button already names it, so it opts out. */
    showHeading = true,
    /** Surface-specific control that leads the "Add yours" row (the reader's
        share-to-linkblog button, which carries its own shared/draft state). */
    composeLead,
    onSelectFilter,
    onCreateInLane,
    onOpenAuthor,
    onRetry,
  }: {
    laneRow?: LaneRowVM[];
    filters?: DiscussionFilterVM[];
    activeFilter?: DiscussionFilterId;
    stream?: DiscussionStreamVM;
    sembleContext?: SembleContextVM;
    lanesOpen?: boolean;
    panelId?: string;
    showHeading?: boolean;
    composeLead?: Snippet;
    onSelectFilter?: (id: DiscussionFilterId) => void;
    onCreateInLane?: (id: LaneId) => void;
    onOpenAuthor?: (did: string) => void;
    onRetry?: () => void;
  } = $props();

  // The headline count: every reference across every lane, before filtering.
  const total = $derived(laneRow.reduce((sum, lane) => sum + lane.count, 0));
  const capped = $derived(laneRow.some((lane) => lane.capped));
  // One populated lane needs no filter row — there is nothing to filter to.
  const showFilters = $derived(filters.length > 2);
  const creatable = $derived(laneRow.filter((lane) => lane.canCreate));
  // Each lane resolves only its most recent handful, so the headline count can
  // outrun the stream. Say so rather than letting "17 references" sit above six
  // people as if that were all of them.
  const linkOnly = $derived(stream.linkOnly ?? []);
  const shown = $derived(stream.entries.length + linkOnly.length);
  // Only once the stream has actually settled: while it is idle or loading,
  // `shown` is 0 for reasons that have nothing to do with how many there are.
  const settled = $derived(!stream.idle && !stream.loading);
  const undisclosed = $derived(
    activeFilter === 'all' && settled && total > shown ? total - shown : 0
  );
  const hasComposeRow = $derived(Boolean(composeLead) || creatable.length > 0);
  const showSemble = $derived(
    Boolean(sembleContext) && (activeFilter === 'all' || activeFilter === 'semble')
  );
  // Whether Semble actually returned something to read. A context object that
  // came back empty (the saver fallback, or an API answer with nothing in it) is
  // not content: it must not stand in for the people who aren't there, or the
  // panel would go silent instead of saying nobody wrote about this.
  const hasSembleContent = $derived(
    showSemble &&
      Boolean(
        sembleContext &&
        (sembleContext.notes.length ||
          sembleContext.collections.length ||
          sembleContext.connections.length ||
          (sembleContext.stats?.saves ?? 0) ||
          (sembleContext.stats?.notes ?? 0) ||
          (sembleContext.stats?.collections ?? 0) ||
          (sembleContext.stats?.connections.total ?? 0))
      )
  );
  const sembleSummary = $derived.by(() => {
    if (!sembleContext?.stats) return [];
    const s = sembleContext.stats;
    return [
      [s.saves, 'save'],
      [s.notes, 'note'],
      [s.collections, 'collection'],
      [s.connections.total, 'connection'],
    ]
      .filter(([n]) => Number(n) > 0)
      .map(([n, label]) => `${n} ${label}${Number(n) === 1 ? '' : 's'}`);
  });

  function connectionLabel(connection: SembleContextVM['connections'][number]): string {
    try {
      return (
        connection.other.title ||
        connection.other.siteName ||
        new URL(connection.other.url).hostname
      );
    } catch {
      return connection.other.title || 'Connected article';
    }
  }

  function displayNameFor(entry: DiscussionEntryVM): string {
    return entry.displayName?.trim() || `@${entry.handle ?? entry.did.slice(0, 18)}`;
  }

  function monogramFor(entry: DiscussionEntryVM): string {
    const source = entry.displayName?.trim() || entry.handle || entry.did.replace('did:plc:', '');
    return source.charAt(0).toUpperCase();
  }

  // A broken avatar URL (a deleted blob, a CDN miss) hides the image and lets the
  // monogram underneath stand in, rather than leaving a torn-image box.
  function hideBrokenAvatar(event: Event) {
    (event.currentTarget as HTMLImageElement).style.display = 'none';
  }
</script>

{#if lanesOpen && (total > 0 || hasComposeRow)}
  <section class="discussion" class:no-heading={!showHeading} id={panelId} aria-label="Discussion">
    {#if showHeading}
      <div class="discussion-head">
        <h2 class="discussion-title">Discussion</h2>
        {#if total > 0}
          <span class="discussion-total"
            >{total}{capped ? '+' : ''}
            {total === 1 ? 'reference' : 'references'} across the Atmosphere</span
          >
        {/if}
      </div>
    {/if}

    <!-- Lanes are filters over the one stream, not navigation between four of
         them. `All` is the resting state; a lane narrows to its own network. -->
    {#if showFilters}
      <div class="discussion-filters" role="group" aria-label="Filter by source">
        {#each filters as filter (filter.id)}
          {@const isActive = activeFilter === filter.id}
          <button
            type="button"
            class="filter-chip"
            class:active={isActive}
            aria-pressed={isActive}
            onclick={(e) => {
              e.stopPropagation();
              onSelectFilter?.(filter.id);
            }}
          >
            {#if filter.icon}
              <span class="filter-icon"><Icon name={filter.icon} size={13} /></span>
            {/if}
            <span class="filter-label">{filter.label}</span>
            <span class="filter-count">{filter.count}{filter.capped ? '+' : ''}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if showSemble && sembleContext && (hasSembleContent || sembleContext.incomplete)}
      <section class="semble-context" aria-label="Semble context">
        {#if sembleSummary.length}
          <p class="semble-summary">{sembleSummary.join(' · ')}</p>
        {/if}
        {#if sembleContext.collections.length}
          <div class="semble-section">
            <h3>In collections</h3>
            <div class="semble-collections">
              {#each sembleContext.collections as collection (collection.id)}
                {#if collection.url}
                  <a
                    href={safeHref(collection.url)}
                    target="_blank"
                    rel="noopener"
                    onclick={(e) => e.stopPropagation()}
                    ><Icon name="folder" size={12} />{collection.name}</a
                  >
                {:else}<span><Icon name="folder" size={12} />{collection.name}</span>{/if}
              {/each}
            </div>
          </div>
        {/if}
        {#if sembleContext.notes.length}
          <div class="semble-section">
            <h3>Notes</h3>
            {#each sembleContext.notes as note (note.id)}
              <div class="semble-note">
                <p>{note.text}</p>
                <button type="button" onclick={() => onOpenAuthor?.(note.author.did)}
                  >@{note.author.handle || note.author.did.slice(0, 18)}</button
                >
              </div>
            {/each}
          </div>
        {/if}
        {#if sembleContext.connections.length}
          <div class="semble-section">
            <h3>Connections</h3>
            <ul class="semble-connections">
              {#each sembleContext.connections as connection (connection.id)}
                <li>
                  <div
                    class="connection-line"
                    aria-label={connection.direction === 'out'
                      ? `This article connects ${connection.type ?? 'to'} ${connectionLabel(connection)}`
                      : `${connectionLabel(connection)} connects ${connection.type ?? 'to'} this article`}
                  >
                    {#if connection.direction === 'out'}
                      <span>this</span>
                      <span aria-hidden="true">→</span>
                      <span class="connection-type">{connection.type ?? 'connected'}</span>
                      <span aria-hidden="true">→</span>
                      <a
                        href={safeHref(connection.other.url)}
                        target="_blank"
                        rel="noopener"
                        onclick={(e) => e.stopPropagation()}>{connectionLabel(connection)}</a
                      >
                    {:else}
                      <a
                        href={safeHref(connection.other.url)}
                        target="_blank"
                        rel="noopener"
                        onclick={(e) => e.stopPropagation()}>{connectionLabel(connection)}</a
                      >
                      <span aria-hidden="true">→</span>
                      <span class="connection-type">{connection.type ?? 'connected'}</span>
                      <span aria-hidden="true">→</span>
                      <span>this</span>
                    {/if}
                  </div>
                  {#if connection.note}<p class="connection-note">{connection.note}</p>{/if}
                  <button
                    class="connection-curator"
                    type="button"
                    onclick={() => onOpenAuthor?.(connection.curator.did)}
                    >by @{connection.curator.handle || connection.curator.did.slice(0, 18)}</button
                  >
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if sembleContext.incomplete}<p class="semble-incomplete">
            Some Semble context is unavailable.
          </p>{/if}
        {#if Object.values(sembleContext.truncated).some(Boolean)}
          <a class="semble-more" href="https://semble.so" target="_blank" rel="noopener"
            >Show more on Semble</a
          >
        {/if}
      </section>
    {/if}

    {#if stream.entries.length > 0}
      <ul class="discussion-stream">
        {#each stream.entries as entry (entry.key)}
          <li class="entry">
            <button
              type="button"
              class="entry-avatar"
              title="Follow {entry.handle ?? entry.did} in Skyreader"
              aria-label="Follow {displayNameFor(entry)} in Skyreader"
              onclick={(e) => {
                e.stopPropagation();
                onOpenAuthor?.(entry.did);
              }}
            >
              <span class="entry-monogram" aria-hidden="true">{monogramFor(entry)}</span>
              {#if entry.avatar}
                <img
                  class="entry-photo"
                  src={entry.avatar}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onerror={hideBrokenAvatar}
                />
              {/if}
              <span class="entry-source" title={entry.laneLabel}>
                <Icon name={entry.laneIcon} size={10} />
              </span>
            </button>

            <div class="entry-body">
              <div class="entry-head">
                <span class="entry-name">{displayNameFor(entry)}</span>
                {#if entry.displayName?.trim() && entry.handle}
                  <span class="entry-handle">@{entry.handle}</span>
                {/if}
                {#if entry.headVerb}
                  <span class="entry-verb">{entry.headVerb}</span>
                {/if}
                {#if entry.relativeTime}
                  <span class="entry-sep" aria-hidden="true">·</span>
                  <time class="entry-time" datetime={entry.isoTime ?? undefined}
                    >{entry.relativeTime}</time
                  >
                {/if}
                {#if entry.url}
                  <a
                    class="entry-out"
                    href={safeHref(entry.url)}
                    target="_blank"
                    rel="noopener"
                    title="Open on {entry.laneLabel}"
                    aria-label="Open on {entry.laneLabel}"
                    onclick={(e) => e.stopPropagation()}
                  >
                    <Icon name="external-link" size={13} />
                  </a>
                {/if}
              </div>

              <!-- A margin.at note targets a passage: the passage is the point, so
                   it leads, with the annotator's own words beneath it. -->
              {#if entry.quote}
                <p class="entry-quote">{entry.quote}</p>
              {/if}

              {#if entry.cleanNote}
                {#if entry.url}
                  <a
                    class="entry-note"
                    href={safeHref(entry.url)}
                    target="_blank"
                    rel="noopener"
                    onclick={(e) => e.stopPropagation()}>{entry.cleanNote}</a
                  >
                {:else}
                  <p class="entry-note">{entry.cleanNote}</p>
                {/if}
              {/if}

              <!-- Semble saves aren't notes — what matters is which collection
                   the article was filed into. -->
              {#if entry.collections?.length}
                <div class="entry-collections">
                  <span class="entry-verb">saved to</span>
                  {#each entry.collections as col (col.name + (col.url ?? ''))}
                    {#if col.url}
                      <a
                        class="entry-collection"
                        href={col.url}
                        target="_blank"
                        rel="noopener"
                        title="Open “{col.name}” on Semble"
                        onclick={(e) => e.stopPropagation()}
                        ><Icon name="folder" size={11} />{col.name}</a
                      >
                    {:else}
                      <span class="entry-collection"
                        ><Icon name="folder" size={11} />{col.name}</span
                      >
                    {/if}
                  {/each}
                </div>
              {:else if entry.lane === 'semble' && !entry.cleanNote}
                <p class="entry-note muted">Saved this</p>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- People are still resolving. Show the shape of what's coming rather than
         the word "Loading" — the stream is the content here. -->
    {#if stream.loading}
      <ul class="discussion-stream skeletons" aria-hidden="true">
        {#each [0, 1, 2] as row (row)}
          <li class="entry skeleton-entry">
            <span class="entry-avatar skeleton-block"></span>
            <div class="entry-body">
              <span class="skeleton-block skeleton-line short"></span>
              <span class="skeleton-block skeleton-line"></span>
            </div>
          </li>
        {/each}
      </ul>
      <span class="visually-hidden" role="status">Loading the discussion…</span>
    {/if}

    <!-- Bridges and bots that posted the headline and the URL and nothing else.
         Each of these used to take a full row with an empty body; as one line
         they read as what they are — distribution, not discussion — and the
         people who said something keep the stream to themselves. -->
    {#if linkOnly.length > 0}
      <div class="also-linked" class:leading={stream.entries.length === 0}>
        <span class="also-linked-label">Also linked by</span>
        {#each linkOnly as entry (entry.key)}
          {@const label = displayNameFor(entry)}
          {@const hint = entry.relativeTime
            ? `${label} · ${entry.laneLabel} · ${entry.relativeTime}`
            : `${label} · ${entry.laneLabel}`}
          {#if entry.url}
            <a
              class="also-link"
              href={safeHref(entry.url)}
              target="_blank"
              rel="noopener"
              title={hint}
              onclick={(e) => e.stopPropagation()}
            >
              <span class="also-avatar">
                <span class="also-monogram" aria-hidden="true">{monogramFor(entry)}</span>
                {#if entry.avatar}
                  <img
                    class="also-photo"
                    src={entry.avatar}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onerror={hideBrokenAvatar}
                  />
                {/if}
              </span>
              <span class="also-name">{label}</span>
            </a>
          {:else}
            <span class="also-link" title={hint}>
              <span class="also-avatar">
                <span class="also-monogram" aria-hidden="true">{monogramFor(entry)}</span>
                {#if entry.avatar}
                  <img
                    class="also-photo"
                    src={entry.avatar}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onerror={hideBrokenAvatar}
                  />
                {/if}
              </span>
              <span class="also-name">{label}</span>
            </span>
          {/if}
        {/each}
      </div>
    {/if}

    {#if undisclosed > 0 && shown > 0 && !hasSembleContent}
      <p class="discussion-more">
        {undisclosed}{capped ? '+' : ''} more, further back.
      </p>
    {/if}

    <!-- Semble context that carries something counts as readable content, so a
         connections-only article never claims nothing came back. A lane that
         failed still gets its retry either way — losing it behind context from a
         different network would strand the reader on a partial answer. -->
    {#if settled && shown === 0 && (stream.failed || !hasSembleContent)}
      {#if stream.failed}
        <p class="discussion-empty">
          {hasSembleContent
            ? "Some of the Atmosphere didn't answer."
            : "Couldn't reach the Atmosphere just now."}
          <button type="button" class="discussion-retry" onclick={() => onRetry?.()}>
            Try again
          </button>
        </p>
      {:else if activeFilter !== 'all'}
        <p class="discussion-empty">Nothing readable from this one.</p>
      {:else if total > 0}
        <p class="discussion-empty">Nothing readable came back.</p>
      {:else}
        <p class="discussion-empty">No one has written about this yet.</p>
      {/if}
    {/if}

    {#if hasComposeRow}
      <div class="discussion-compose">
        <span class="compose-label">Add yours</span>
        {#if composeLead}{@render composeLead()}{/if}
        {#each creatable as lane (lane.id)}
          <button
            type="button"
            class="compose-btn"
            title={lane.createLabel}
            aria-label={lane.createLabel}
            onclick={(e) => {
              e.stopPropagation();
              onCreateInLane?.(lane.id);
            }}
          >
            <span class="compose-icon"><Icon name={lane.icon} size={14} /></span>
            <span>{lane.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .discussion {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* In the card's sticky footer there is no heading to open the section, so the
     panel supplies the gap the heading would have made. */
  .discussion.no-heading {
    padding-top: 0.625rem;
  }

  /* Section framing. More space above the heading than below it: the discussion
     is a new movement after the article, and its own parts belong together. */
  .discussion-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .discussion-title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    color: var(--color-text);
  }

  .discussion-total {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .discussion-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-bottom: 0.875rem;
  }

  /* Filters are pills on the sunken tone — quieter than a bordered control,
     because narrowing the stream is a side road, not the main act. */
  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.25rem 0.5625rem;
    border: none;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }

  .filter-chip:hover {
    color: var(--color-text);
  }

  .filter-chip.active {
    background: var(--color-sidebar-active);
    color: var(--color-primary);
  }

  .filter-icon {
    display: inline-flex;
    flex-shrink: 0;
  }

  .filter-count {
    font-variant-numeric: tabular-nums;
    color: inherit;
    opacity: 0.7;
  }

  .filter-chip.active .filter-count {
    opacity: 1;
  }

  /* The stream: borderless rows separated by rhythm, like the feed itself. */
  .discussion-stream {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .semble-context {
    margin: 0 0 1rem;
    padding: 0.75rem 0;
    border-block: 1px solid var(--color-border);
  }
  .semble-summary,
  .semble-incomplete {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .semble-section {
    margin-top: 0.75rem;
  }
  .semble-section h3 {
    margin: 0 0 0.375rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }
  .semble-collections {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .semble-collections a,
  .semble-collections span {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1875rem 0.5rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    text-decoration: none;
  }
  .semble-collections a:hover,
  .semble-more:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }
  .semble-note {
    margin-top: 0.5rem;
  }
  .semble-note p,
  .connection-note {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .semble-note button,
  .connection-curator {
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .semble-note button:hover,
  .connection-curator:hover {
    color: var(--color-primary);
  }
  .semble-connections {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .connection-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3125rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }
  .connection-line a,
  .semble-more {
    color: var(--color-primary);
    text-decoration: none;
  }
  .connection-type {
    padding: 0.125rem 0.4375rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font-size: var(--text-xs);
  }
  .connection-note {
    margin-top: 0.25rem;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .connection-curator {
    margin-top: 0.1875rem;
  }
  .semble-incomplete,
  .semble-more {
    display: block;
    margin-top: 0.75rem;
    font-size: var(--text-sm);
  }

  .entry {
    display: flex;
    gap: 0.625rem;
    min-width: 0;
  }

  /* The person. The avatar wears its network as a small glyph, so the source is
     legible without a word of chrome. */
  .entry-avatar {
    position: relative;
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--color-bg-secondary);
    cursor: pointer;
  }

  .entry-monogram {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    user-select: none;
  }

  .entry-photo {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    background: var(--color-bg-secondary);
  }

  .entry-source {
    position: absolute;
    right: -4px;
    bottom: -4px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: content-box;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    /* Knocked out of the page's own ground, so the glyph reads as pinned to the
       avatar rather than floating over it. A border, not a shadow — nothing here
       has left the page plane. */
    border: 1.5px solid var(--color-bg);
    background: var(--color-bg);
    color: var(--color-text-secondary);
  }

  .entry-avatar:hover .entry-source {
    color: var(--color-primary);
  }

  .entry-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .entry-head {
    display: flex;
    align-items: baseline;
    gap: 0.3125rem;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .entry-name {
    flex-shrink: 0;
    max-width: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--weight-semibold);
    color: var(--color-text);
  }

  /* The handle identifies; it doesn't lead. It yields its width first. */
  .entry-handle {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .entry-verb,
  .entry-sep,
  .entry-time {
    flex-shrink: 0;
    white-space: nowrap;
    color: var(--color-text-secondary);
  }

  .entry-out {
    flex-shrink: 0;
    display: inline-flex;
    align-self: center;
    margin-left: 0.125rem;
    color: var(--color-text-secondary);
    transition: color 0.15s ease;
  }

  .entry:hover .entry-out,
  .entry-out:hover {
    color: var(--color-primary);
  }

  /* What the person actually said, in ink — the substance of the row, and the
     reason it beats the handle for weight. */
  .entry-note {
    margin: 0.1875rem 0 0;
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--color-text);
    text-decoration: none;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Hovering the words underlines them rather than repainting a whole paragraph
     in the interaction blue — the head's arrow already carries the tint. */
  a.entry-note:hover {
    text-decoration: underline;
    text-decoration-color: var(--color-border);
    text-underline-offset: 2px;
  }

  .entry-note.muted {
    color: var(--color-text-secondary);
  }

  /* The passage a margin.at note points at. The rule is a quotation mark, the
     one place a side stroke is a convention rather than an accent. */
  .entry-quote {
    margin: 0.375rem 0 0;
    padding-left: 0.5625rem;
    border-left: 2px solid var(--color-border);
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .entry-collections {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3125rem;
    margin-top: 0.25rem;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
  }

  .entry-collection {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    font-weight: var(--weight-medium);
    color: var(--color-text);
    text-decoration: none;
    white-space: nowrap;
  }

  .entry-collection :global(.icon) {
    opacity: 0.7;
  }

  a.entry-collection:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  a.entry-collection:hover :global(.icon) {
    opacity: 1;
  }

  /* One quiet line, not a list. Pills on the sunken tone group them as a set and
     keep them clearly subordinate to the stream above. */
  .also-linked {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 1rem;
  }

  /* When nobody commented, this line IS the content — it shouldn't hang off a
     gap meant to separate it from a stream that isn't there. */
  .also-linked.leading {
    margin-top: 0;
  }

  .also-linked-label {
    margin-right: 0.125rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .also-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    max-width: 100%;
    padding: 0.125rem 0.5rem 0.125rem 0.1875rem;
    border-radius: 999px;
    background: var(--color-bg-secondary);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-decoration: none;
    transition: color 0.15s ease;
  }

  a.also-link:hover {
    color: var(--color-primary);
  }

  .also-avatar {
    position: relative;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
  }

  .also-monogram {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--color-bg);
    font-size: var(--text-3xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    user-select: none;
  }

  .also-photo {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
  }

  .also-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .discussion-more {
    margin: 0.875rem 0 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .discussion-empty {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .discussion-retry {
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    color: var(--color-primary);
    text-decoration: underline;
    cursor: pointer;
  }

  /* Loading shows the shape of a person, not a spinner: the stream is the
     content, so its silhouette is the honest placeholder. */
  .skeletons {
    margin-top: 0;
  }

  .skeleton-block {
    display: block;
    border-radius: 4px;
    /* NOT the Sunken tone: that is exactly the card footer's own background, and
       the silhouette vanished into it. Derived from the ink so it reads on any
       surface, in either theme. */
    background: color-mix(in srgb, var(--color-text) 11%, transparent);
    animation: skeleton-fade 1.4s ease-in-out infinite;
  }

  .skeleton-entry .entry-avatar {
    border-radius: 50%;
    cursor: default;
  }

  .skeleton-line {
    width: 78%;
    height: 0.6875rem;
    margin-top: 0.375rem;
  }

  .skeleton-line.short {
    width: 34%;
    margin-top: 0.25rem;
  }

  .skeleton-entry:nth-child(2) .skeleton-line:not(.short) {
    width: 62%;
  }

  .skeleton-entry:nth-child(3) .skeleton-line:not(.short) {
    width: 85%;
  }

  .skeleton-entry:nth-child(2) .skeleton-block {
    animation-delay: 0.12s;
  }

  .skeleton-entry:nth-child(3) .skeleton-block {
    animation-delay: 0.24s;
  }

  @keyframes skeleton-fade {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }

  /* Answering comes last, after a hairline — the place a reply belongs. */
  .discussion-compose {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 1.125rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--color-border);
  }

  .compose-label {
    margin-right: 0.125rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
    color: var(--color-text-secondary);
  }

  .compose-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.625rem;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: none;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-none);
    color: var(--color-text);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      color 0.15s ease;
  }

  .compose-btn:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }

  .compose-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .compose-btn:hover .compose-icon {
    color: var(--color-primary);
  }

  /* Keyboard focus is visible on every control here, in the interaction blue.
     PRODUCT.md's accessibility floor asks for a visible focus state; a 10%-alpha
     wash would technically be "the ring" and practically be invisible. */
  .filter-chip:focus-visible,
  .compose-btn:focus-visible,
  .entry-avatar:focus-visible,
  .entry-out:focus-visible,
  .entry-note:focus-visible,
  .entry-collection:focus-visible,
  .also-link:focus-visible,
  .discussion-retry:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .entry-avatar:focus-visible {
    border-radius: 50%;
  }

  .filter-chip:focus-visible,
  .compose-btn:focus-visible,
  .also-link:focus-visible {
    border-radius: 999px;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Inside a feed card the panel rides a sticky footer, so it tightens its
     rhythm and lets the avatar shrink rather than pushing the action row down. */
  @container card (max-width: 34rem) {
    .discussion-stream {
      gap: 0.8125rem;
    }

    .entry-avatar {
      width: 26px;
      height: 26px;
    }

    .entry-name {
      max-width: 16ch;
    }
  }

  @media (max-width: 640px) {
    /* On a phone the head line has no room for both names. The avatar and the
       display name identify the person; the handle is the part that goes. Where
       there is no display name the handle IS the name, so it stays. */
    .entry-handle {
      display: none;
    }

    .entry-name {
      max-width: 22ch;
    }

    .discussion-compose {
      margin-top: 1rem;
      padding-top: 0.75rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .filter-chip,
    .entry-out,
    .compose-btn,
    .compose-icon,
    .also-link {
      transition: none;
    }

    .skeleton-block {
      animation: none;
    }
  }
</style>
