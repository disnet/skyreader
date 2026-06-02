<script lang="ts">
  // PURE presentational article card. Renders entirely from props — no stores,
  // no services, no fetching $effects. All data resolution and interaction logic
  // lives in the container (ArticleCard.svelte). See articleCardView.types.ts.
  import Icon from './Icon.svelte';
  import ShareCommentBox from '$lib/components/feed/ShareCommentBox.svelte';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import type { ArticleCardViewProps } from './articleCardView.types';

  let {
    // data
    itemUrl,
    itemTitle,
    relativeDate,
    faviconUrl,
    displayFeedTitle,
    feedTitle,
    feedId,
    readTimeMinutes,
    sanitizedContent,
    hasContent,
    isDocumentMode,
    isLinkPostMode,
    linkPostNote,
    linkPostExcerpt,
    linkPostThumb,
    authorHandle,
    authorDisplayName,
    authorAvatar,
    authorDid,
    socialContext,
    alsoLinkedBy = [],
    laneRow = [],
    expandedLane = null,
    expandedLaneItems,
    expandedLaneMeta,
    itemTagCount,
    itemTags = [],
    // state
    isRead = false,
    isSaved = false,
    selected = false,
    expanded = false,
    isOpen,
    highlighted = false,
    isTruncated = false,
    currentlyShared = false,
    currentNote,
    shareLabel,
    shareBusy = false,
    showShareAction = false,
    showActionBarIntegrations = false,
    isActionBarFloating = false,
    mobileControlsVisible = false,
    overflowMenuOpen = false,
    canFollowSource = false,
    hasSaveToSemble = false,
    hasSaveToMargin = false,
    hasOpenFullscreen = false,
    // bindings
    bodyEl = $bindable(),
    tagBtnRef = $bindable(),
    overflowTriggerRef = $bindable(),
    actionBarSentinelRef = $bindable(),
    // callbacks
    onHeaderClick,
    onContentTap,
    onToggleRead,
    onToggleSave,
    onShareClick,
    onOpenUrl,
    onOpenFullscreen,
    onExpandToggle,
    onTagClick,
    onOverflowClick,
    onOverflowOpenUrl,
    onOverflowTag,
    onOverflowSemble,
    onOverflowMargin,
    onSaveToSemble,
    onSaveToMargin,
    onFollowSource,
    onToggleLane,
    onCreateInLane,
    onApplyComment,
    onOpenAuthor,
    onCloseOverflow,
  }: ArticleCardViewProps = $props();

  // The content tap: keep the pure DOM guards here (let real links / media play),
  // then hand off the expand-vs-select decision to the container via onContentTap.
  function handleContentClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('a')) return;
    if ((e.target as HTMLElement).closest('video, audio, iframe')) return;
    e.stopPropagation();
    onContentTap?.();
  }
</script>

<article
  class="article-item"
  class:read={isRead}
  class:selected
  class:expanded
  class:open={isOpen}
  class:highlighted
>
  <div class="article-sticky-header">
    <div class="article-header-row">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <span
        class="read-toggle"
        class:unread={!isRead}
        title={isRead ? 'Mark unread' : 'Mark read'}
        onclick={(e) => {
          e.stopPropagation();
          onToggleRead?.();
        }}
        role="button"
        tabindex="-1"
      >
        <span class="read-dot"></span>
      </span>
      <button class="article-header" onclick={() => onHeaderClick?.()}>
        <span class="title-line">
          {#if faviconUrl}
            <img src={faviconUrl} alt="" class="favicon" />
          {/if}
          <span class="article-title">
            {#if isOpen}
              <a
                href={itemUrl}
                target="_blank"
                rel="noopener"
                class="article-title-link"
                onclick={(e) => e.stopPropagation()}>{itemTitle}</a
              >
            {:else}
              {itemTitle}
            {/if}
          </span>
        </span>
        {#if isLinkPostMode && authorDid}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <span
            class="via-pill"
            title="@{authorHandle}"
            onclick={(e) => {
              e.stopPropagation();
              onOpenAuthor?.(authorDid);
            }}
            role="button"
            tabindex="-1"
          >
            <span class="via-label">Shared by</span>
            {#if authorAvatar}
              <img src={authorAvatar} alt="" class="via-avatar" />
            {/if}
            <span class="via-name">{authorDisplayName}</span>
          </span>
        {/if}
        {#if displayFeedTitle && !isLinkPostMode}
          {#if feedId}
            <a
              href="/?feed={feedId}"
              class="feed-title-link"
              title={isDocumentMode ? 'standard.site' : 'RSS'}
              onclick={(e) => e.stopPropagation()}
              ><Icon
                name={isDocumentMode ? 'standard-site' : 'rss'}
                size={12}
              />{displayFeedTitle}</a
            >
          {:else}
            <span class="feed-title-label" title={isDocumentMode ? 'standard.site' : 'RSS'}
              ><Icon
                name={isDocumentMode ? 'standard-site' : 'rss'}
                size={12}
              />{displayFeedTitle}</span
            >
          {/if}
        {/if}
        {#if readTimeMinutes > 0}
          <span class="article-read-time"
            ><Icon name="clock" size={12} /> {readTimeMinutes} min</span
          >
        {/if}
        <span class="article-date">{relativeDate}</span>
      </button>
    </div>
  </div>

  {#if isOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div class="article-content" onclick={handleContentClick}>
      {#if isLinkPostMode}
        <!-- A link post: the author's note as prose, then the external article as
             a card. Tapping the card opens the in-app reader (fetched on demand). -->
        {#if linkPostNote}
          <p class="link-post-note">{linkPostNote}</p>
        {/if}
        <button
          class="link-card"
          onclick={(e) => {
            e.stopPropagation();
            onOpenFullscreen?.();
          }}
        >
          {#if linkPostThumb}
            <img src={linkPostThumb} alt="" class="link-card-thumb" />
          {/if}
          <span class="link-card-body">
            <span class="link-card-site">
              {#if faviconUrl}<img src={faviconUrl} alt="" class="link-card-favicon" />{/if}
              {#if displayFeedTitle}{displayFeedTitle}{/if}
            </span>
            <span class="link-card-title">{itemTitle}</span>
            {#if linkPostExcerpt}
              <span class="link-card-excerpt">{linkPostExcerpt}</span>
            {/if}
          </span>
        </button>
      {:else if hasContent}
        <div class="article-body-wrapper" class:has-fade={selected && !expanded && isTruncated}>
          <div
            bind:this={bodyEl}
            class="article-body"
            class:truncated={selected && !expanded}
            use:bskyEmbed
          >
            {@html sanitizedContent}
          </div>
        </div>
      {/if}
    </div>

    <!-- Link-post social context (Constellation): recommends, quotes, and who
         else across the Atmosphere linked this article. Adornment only. -->
    {#if isLinkPostMode && socialContext && (socialContext.recommendCount > 0 || socialContext.quoteCount > 0 || alsoLinkedBy.length > 0)}
      <div class="link-post-context">
        {#if socialContext.recommendCount > 0 || socialContext.quoteCount > 0}
          <span class="context-stat">
            {#if socialContext.recommendCount > 0}{socialContext.recommendCount}
              {socialContext.recommendCount === 1
                ? 'recommend'
                : 'recommends'}{/if}{#if socialContext.recommendCount > 0 && socialContext.quoteCount > 0}
              ·
            {/if}{#if socialContext.quoteCount > 0}{socialContext.quoteCount}
              {socialContext.quoteCount === 1 ? 'quote' : 'quotes'}{/if}
          </span>
        {/if}
        {#if alsoLinkedBy.length > 0}
          <div class="context-also-linked">
            <span class="context-also-label">also linked by</span>
            {#each alsoLinkedBy as entry (entry.recordUri)}
              <span class="context-also-entry">
                <button
                  class="context-handle"
                  onclick={(e) => {
                    e.stopPropagation();
                    onOpenAuthor?.(entry.did);
                  }}>@{entry.handle ?? entry.did.slice(0, 16)}</button
                >{#if entry.note}<span class="context-note">“{entry.note}”</span>{/if}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- The Atmosphere row (Phase 5): for an open article, one quiet line of
         source lanes. Each lane shows how many others referenced this URL that
         way AND is the affordance to add yours; tapping expands the people. -->
    {#if laneRow.length > 0}
      <div class="atmosphere">
        <div class="atmosphere-lanes">
          {#each laneRow as row (row.id)}
            <button
              type="button"
              class="lane-chip"
              class:active={expandedLane === row.id}
              class:mine={row.isMine}
              title={row.title}
              onclick={(e) => {
                e.stopPropagation();
                onToggleLane?.(row.id);
              }}
            >
              <Icon name={row.icon} size={14} />
              {#if row.count > 0}
                <span class="lane-count">{row.count}{row.capped ? '+' : ''}</span>
              {:else}
                <span class="lane-label">{row.label}</span>
              {/if}
              <Icon name={expandedLane === row.id ? 'chevron-up' : 'chevron-down'} size={12} />
            </button>
          {/each}
        </div>

        {#if expandedLane && expandedLaneMeta}
          {@const lane = expandedLane}
          {@const meta = expandedLaneMeta}
          <div class="lane-detail">
            {#if expandedLaneItems?.loading}
              <div class="lane-detail-status">Loading…</div>
            {:else if expandedLaneItems && expandedLaneItems.entries.length > 0}
              <ul class="lane-people">
                {#each expandedLaneItems.entries as entry (entry.did + (entry.url ?? ''))}
                  <li class="lane-person">
                    <button
                      type="button"
                      class="lane-person-handle"
                      onclick={(e) => {
                        e.stopPropagation();
                        onOpenAuthor?.(entry.did);
                      }}>@{entry.handle ?? entry.did.slice(0, 18)}</button
                    >
                    {#if entry.note}<span class="lane-person-note">{entry.note}</span>{/if}
                    {#if entry.url}
                      <a
                        class="lane-person-link"
                        href={entry.url}
                        target="_blank"
                        rel="noopener"
                        title="Open {meta.label}"
                        onclick={(e) => e.stopPropagation()}
                        ><Icon name="external-link" size={13} /></a
                      >
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else if !expandedLaneItems?.loading}
              <!-- Loaded-empty, or a zero-count lane we never fetched: same hint. -->
              <div class="lane-detail-status">
                {#if meta.canCreate}Be the first to {meta.verb} this.{:else}Nothing here yet.{/if}
              </div>
            {/if}

            {#if meta.canCreate}
              <button
                type="button"
                class="lane-create"
                class:done={meta.createIsEdit}
                onclick={(e) => {
                  e.stopPropagation();
                  onCreateInLane?.(lane);
                }}
              >
                <Icon name={meta.createIsEdit ? 'edit' : 'plus'} size={14} />
                <span>{meta.createLabel}</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Mobile: meta line below content -->
    <div class="article-meta-mobile">
      {#if faviconUrl}
        <img src={faviconUrl} alt="" class="favicon" />
      {/if}
      {#if feedTitle}
        <a
          href="/?feed={feedId}"
          class="feed-title-link"
          title={isDocumentMode ? 'standard.site' : 'RSS'}
          onclick={(e) => e.stopPropagation()}
          ><Icon name={isDocumentMode ? 'standard-site' : 'rss'} size={12} />{feedTitle}</a
        >
      {/if}
      {#if readTimeMinutes > 0}
        <span class="article-read-time"><Icon name="clock" size={12} /> {readTimeMinutes} min</span>
      {/if}
      <span class="article-date">{relativeDate}</span>
    </div>

    <!-- Inline share-comment composer: present for as long as the item is shared. -->
    {#if currentlyShared}
      <ShareCommentBox
        initialNote={currentNote ?? ''}
        onsubmit={(note) => onApplyComment?.(note)}
      />
    {/if}

    <div
      class="article-actions-container"
      class:scroll-hidden={expanded && isActionBarFloating && !mobileControlsVisible}
      class:floating={isActionBarFloating}
    >
      <div class="article-actions">
        <!-- Save button -->
        <button
          class="action-btn"
          class:saved={isSaved}
          onclick={(e) => {
            e.stopPropagation();
            onToggleSave?.();
          }}
        >
          <span class="action-icon"><Icon name="bookmark" size={16} /></span><span
            class="action-label">Save</span
          >
        </button>
        <!-- Share is a toggle: one tap shares (the comment box appears); again unshares. -->
        {#if showShareAction}
          <button
            class="action-btn"
            class:shared={currentlyShared}
            onclick={(e) => {
              e.stopPropagation();
              onShareClick?.();
            }}
            disabled={shareBusy}
            aria-pressed={currentlyShared}
          >
            <span class="action-icon"><Icon name="share" size={16} /></span><span
              class="action-label">{shareLabel}</span
            >
          </button>
        {/if}
        {#if hasOpenFullscreen && hasContent}
          <button
            class="action-btn"
            onclick={(e) => {
              e.stopPropagation();
              onOpenFullscreen?.();
            }}
          >
            <span class="action-icon"><Icon name="maximize" size={16} /></span><span
              class="action-label">Full</span
            >
          </button>
        {/if}
        <!-- Inline open & tag — visible when there's space, hidden when narrow -->
        <button
          class="action-btn collapsible"
          onclick={(e) => {
            e.stopPropagation();
            onOpenUrl?.();
          }}
        >
          <span class="action-icon"><Icon name="external-link" size={16} /></span><span
            class="action-label">Open</span
          >
        </button>
        <button
          class="action-btn collapsible"
          class:tagged={itemTagCount > 0}
          onclick={(e) => {
            e.stopPropagation();
            onTagClick?.();
          }}
          bind:this={tagBtnRef}
        >
          <span class="action-icon"><Icon name="tag" size={16} /></span><span class="action-label"
            >Tag{#if itemTagCount > 0}<span class="tag-count">({itemTagCount})</span>{/if}</span
          >
        </button>
        {#if showActionBarIntegrations && hasSaveToSemble}
          <button
            class="action-btn collapsible-always"
            onclick={(e) => {
              e.stopPropagation();
              onSaveToSemble?.();
            }}
          >
            <span class="action-icon"><Icon name="semble" size={16} /></span><span
              class="action-label">Semble</span
            >
          </button>
        {/if}
        {#if showActionBarIntegrations && hasSaveToMargin}
          <button
            class="action-btn collapsible-always"
            onclick={(e) => {
              e.stopPropagation();
              onSaveToMargin?.();
            }}
          >
            <span class="action-icon"><Icon name="margin" size={16} /></span><span
              class="action-label">Margin</span
            >
          </button>
        {/if}
        <!-- Overflow menu: shown when inline buttons are collapsed -->
        <div
          class="overflow-menu-wrapper"
          class:has-integrations={showActionBarIntegrations && (hasSaveToSemble || hasSaveToMargin)}
        >
          <button
            class="action-btn overflow-trigger"
            class:tagged={itemTagCount > 0}
            onclick={(e) => {
              e.stopPropagation();
              onOverflowClick?.();
            }}
            bind:this={overflowTriggerRef}
          >
            <span class="action-icon"><Icon name="more-horizontal" size={16} /></span>
          </button>
          {#if overflowMenuOpen}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="overflow-backdrop" onclick={() => onCloseOverflow?.()}></div>
            <div class="overflow-menu">
              <button
                class="overflow-menu-item narrow-only"
                onclick={(e) => {
                  e.stopPropagation();
                  onOverflowOpenUrl?.();
                }}
              >
                <Icon name="external-link" size={16} />
                <span>Open in browser</span>
              </button>
              <button
                class="overflow-menu-item narrow-only"
                class:tagged={itemTagCount > 0}
                onclick={(e) => {
                  e.stopPropagation();
                  onOverflowTag?.();
                }}
              >
                <Icon name="tag" size={16} />
                <span
                  >Tag{#if itemTagCount > 0}
                    ({itemTagCount}){/if}</span
                >
              </button>
              {#if showActionBarIntegrations && hasSaveToSemble}
                <button
                  class="overflow-menu-item"
                  onclick={(e) => {
                    e.stopPropagation();
                    onOverflowSemble?.();
                  }}
                >
                  <Icon name="semble" size={16} />
                  <span>Save to Semble</span>
                </button>
              {/if}
              {#if showActionBarIntegrations && hasSaveToMargin}
                <button
                  class="overflow-menu-item"
                  onclick={(e) => {
                    e.stopPropagation();
                    onOverflowMargin?.();
                  }}
                >
                  <Icon name="margin" size={16} />
                  <span>Save to Margin</span>
                </button>
              {/if}
              {#if canFollowSource}
                <button
                  class="overflow-menu-item"
                  onclick={(e) => {
                    e.stopPropagation();
                    onFollowSource?.();
                  }}
                >
                  <Icon name="plus" size={16} />
                  <span>Follow source</span>
                </button>
              {/if}
            </div>
          {/if}
        </div>
        {#if expanded}
          <button
            class="action-btn show-less-btn"
            onclick={(e) => {
              e.stopPropagation();
              onExpandToggle?.();
            }}
            ><span class="action-icon"><Icon name="chevron-up" size={16} /></span><span
              class="action-label">Less</span
            ></button
          >
        {:else}
          <button
            class="action-btn show-more-btn"
            class:disabled={!isTruncated}
            onclick={isTruncated
              ? (e) => {
                  e.stopPropagation();
                  onExpandToggle?.();
                }
              : undefined}
            ><span class="action-icon"><Icon name="chevron-down" size={16} /></span><span
              class="action-label">More</span
            ></button
          >
        {/if}
      </div>
    </div>
    {#if expanded}<div class="action-bar-sentinel" bind:this={actionBarSentinelRef}></div>{/if}

    {#if itemTagCount > 0}
      <div class="tag-chips">
        {#each itemTags as tag}
          <span class="tag-chip">{tag}</span>
        {/each}
      </div>
    {/if}
  {/if}
</article>

<style>
  .article-item {
    padding: 0 1rem;
  }

  .article-item:not(.selected):not(.expanded):hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .article-item.read:not(.selected):not(.expanded) {
    opacity: 0.6;
  }

  .article-item.read:not(.selected):not(.expanded):hover {
    opacity: 0.8;
  }

  .article-item.highlighted {
    background-color: rgba(96, 165, 250, 0.05);
    border-radius: 8px;
  }

  .article-item:hover {
    background-color: rgba(128, 128, 128, 0.05);
    border-radius: 8px;
    --fade-bg: #f9f9f9;
  }

  .article-item.highlighted:hover {
    background-color: rgba(96, 165, 250, 0.08);
    --fade-bg: #f2f8ff;
  }

  .article-item.highlighted {
    --fade-bg: #f7fbff;
  }

  .article-sticky-header {
    position: relative;
  }

  /* "via @handle" byline pill — sits in the title row's metadata cluster so a
     link post reads as an article with a person attached, not a special card. */
  .via-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    flex-shrink: 0;
    max-width: 11rem;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .via-pill:hover {
    color: var(--color-primary);
  }

  .via-avatar {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    background: var(--color-bg-secondary, #f0f0f0);
  }

  .via-label {
    white-space: nowrap;
  }

  .via-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Link-post body: the note as prose, then the article as a tappable card. */
  .link-post-note {
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: 1.7;
    color: var(--color-text);
    margin: 0 0 1rem;
    overflow-wrap: break-word;
  }

  .link-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
    background: none;
    border: 1px solid var(--color-border, #e5e5e5);
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    padding: 0;
    font: inherit;
  }

  .link-card:hover {
    border-color: var(--color-primary, #0066cc);
  }

  .link-card-thumb {
    width: 100%;
    max-height: 180px;
    object-fit: cover;
  }

  .link-card-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem;
    min-width: 0;
  }

  .link-card-site {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .link-card-favicon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .link-card-title {
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.35;
  }

  .link-card-excerpt {
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* The Atmosphere row (Phase 5) — source lanes for an open article. One quiet
     line of lane chips; each shows others' references and adds yours on expand.
     Flat and neutral per DESIGN.md; the One Blue shows only on hover/active. The
     left indent lines the lanes up under the source favicon. */
  .atmosphere {
    margin: 0.25rem 0 0.5rem;
    padding-left: 1.625rem;
  }

  .atmosphere-lanes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .lane-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.1875rem 0.5rem;
    background: none;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 999px;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .lane-chip:hover,
  .lane-chip.active,
  .lane-chip.mine {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }

  .lane-chip.active {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.08));
  }

  .lane-chip :global(.icon) {
    flex-shrink: 0;
    opacity: 0.9;
  }

  /* The trailing chevron is a soft hint, not a control. */
  .lane-chip > :global(.icon:last-child) {
    opacity: 0.45;
  }

  .lane-count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .lane-label {
    white-space: nowrap;
  }

  .lane-detail {
    margin-top: 0.5rem;
    padding-top: 0.125rem;
    font-size: 0.8125rem;
  }

  .lane-detail-status {
    color: var(--color-text-secondary);
    padding: 0.125rem 0 0.375rem;
  }

  .lane-people {
    list-style: none;
    margin: 0 0 0.375rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }

  .lane-person {
    display: flex;
    align-items: baseline;
    gap: 0.4375rem;
    min-width: 0;
    line-height: 1.4;
  }

  .lane-person-handle {
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .lane-person-handle:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .lane-person-note {
    flex: 1;
    min-width: 0;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lane-person-link {
    flex-shrink: 0;
    display: inline-flex;
    color: var(--color-text-secondary);
  }

  .lane-person-link:hover {
    color: var(--color-primary);
  }

  /* The "add yours" affordance — a quiet One-Blue text button. */
  .lane-create {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    background: none;
    border: none;
    padding: 0.25rem 0;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--color-primary, #0066cc);
    cursor: pointer;
  }

  .lane-create:hover {
    text-decoration: underline;
  }

  .lane-create.done {
    color: var(--color-text-secondary);
  }

  .link-post-context {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0 0 0.75rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--color-border, #e8e8e8);
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .context-stat {
    color: var(--color-text-secondary);
  }

  .context-also-linked {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.375rem;
    line-height: 1.4;
  }

  .context-also-label {
    color: var(--color-text-secondary);
  }

  .context-also-entry {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3125rem;
    min-width: 0;
  }

  .context-handle {
    color: var(--color-text-secondary);
    text-decoration: none;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
  }

  .context-handle:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .context-note {
    color: var(--color-text);
    font-style: italic;
  }

  .article-header-row {
    display: flex;
    align-items: flex-start;
    gap: 2px;
  }

  .article-header {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }

  /* On desktop the wrapper is transparent: favicon + title flow directly into
     the header flex row. On mobile it becomes a full-width row so the favicon
     rides with the title and the meta wraps to a second line (see media query). */
  .title-line {
    display: contents;
  }

  .favicon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    margin-top: 3px;
  }

  .article-title {
    flex: 1;
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    font-weight: 400;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .article-item.read .article-title {
    color: var(--color-text-secondary);
  }

  .read-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 2px 10px 2px 4px;
    cursor: pointer;
    flex-shrink: 0;
    line-height: 0;
    margin-top: calc(0.5rem + 3px);
  }

  .read-dot {
    display: block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: transparent;
    border: 1.5px solid var(--color-text-secondary);
    transition:
      background 0.15s ease,
      border-color 0.15s ease;
  }

  .read-toggle:hover .read-dot {
    border-color: var(--color-primary, #0066cc);
    opacity: 0.7;
  }

  .read-toggle.unread .read-dot {
    background: #5b9bd5;
    border-color: #5b9bd5;
  }

  .read-toggle.unread:hover .read-dot {
    opacity: 0.7;
  }

  .article-title-link {
    color: var(--color-primary, #0066cc);
    text-decoration: none;
  }

  .article-title-link:hover {
    text-decoration: underline;
  }

  .article-item.selected .article-title,
  .article-item.expanded .article-title {
    white-space: normal;
    text-overflow: unset;
  }

  .article-date {
    flex-shrink: 0;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .article-read-time {
    flex-shrink: 0;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
  }

  .article-read-time :global(.icon) {
    vertical-align: -2px;
    margin-right: 0.15rem;
  }

  .feed-title-link :global(.icon),
  .feed-title-label :global(.icon) {
    margin-right: 0.3rem;
    vertical-align: -0.1em;
    color: var(--color-text-secondary);
  }

  .feed-title-link,
  .feed-title-label {
    flex-shrink: 0;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .feed-title-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .article-content {
    padding: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .article-body-wrapper {
    position: relative;
  }

  .article-body-wrapper.has-fade::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 4em;
    background: linear-gradient(to bottom, transparent, var(--fade-bg, var(--color-bg, #ffffff)));
    pointer-events: none;
  }

  @media (prefers-color-scheme: dark) {
    .article-body-wrapper.has-fade::after {
      background: linear-gradient(to bottom, transparent, var(--fade-bg, var(--color-bg, #1a1a1a)));
    }
  }

  .article-body {
    position: relative;
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: 1.7;
    color: var(--color-text);
    overflow-wrap: break-word;
  }

  .article-body.truncated {
    display: -webkit-box;
    -webkit-line-clamp: 8;
    line-clamp: 8;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .article-body :global(video) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 0.75rem 0;
    cursor: auto;
  }

  .article-body :global(iframe) {
    display: block;
    width: 100%;
    max-width: 100%;
    aspect-ratio: 16 / 9;
    height: auto;
    border: 0;
    border-radius: 6px;
    margin: 0.75rem 0;
    cursor: auto;
  }

  .article-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 0.75rem 0;
  }

  .article-body :global(a) {
    color: var(--color-primary, #0066cc);
  }

  .article-body :global(pre) {
    background: var(--color-bg-secondary, #f3f4f6);
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.8rem;
  }

  .article-body :global(blockquote) {
    border-left: 3px solid var(--color-border);
    margin: 0.75rem 0;
    padding-left: 1rem;
    color: var(--color-text-secondary);
  }

  .article-body :global(p) {
    margin: 0.75rem 0;
  }

  .article-body :global(p:first-child) {
    margin-top: 0;
  }

  .article-body :global(p:last-child) {
    margin-bottom: 0;
  }

  .article-body :global(ul),
  .article-body :global(ol) {
    margin: 0.75rem 0;
    padding-left: 1.5rem;
    list-style-position: outside;
  }

  .article-body :global(li ul),
  .article-body :global(li ol) {
    padding-left: 1.5rem;
  }

  .article-body :global(li) {
    margin: 0.25rem 0;
  }

  .article-body :global(mark.highlight) {
    background-color: color-mix(in srgb, #f5c518 25%, transparent);
    border-radius: 1px;
    cursor: pointer;
    transition: background-color 0.2s ease;
  }

  .article-body :global(mark.highlight:hover) {
    background-color: color-mix(in srgb, #f5c518 40%, transparent);
  }

  .article-actions-container {
    display: flex;
    container-type: inline-size;
    padding: 0.25rem 0 0.5rem;
  }

  /* Inline style: flat row integrated into card bottom */
  .article-actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: 0.75rem;
    padding: 0.375rem 0;
  }

  /* Mute controls for non-highlighted articles in expanded view (desktop only) */
  @media (min-width: 1000px) {
    .article-item.open:not(.expanded) .article-actions {
      opacity: 0.3;
    }

    .article-item.open:not(.expanded).highlighted .article-actions,
    .article-item.open:not(.expanded):hover .article-actions {
      opacity: 1;
    }
  }

  /* Expanded: sticky at bottom */
  .article-item.expanded .article-actions-container {
    position: sticky;
    bottom: 0;
    padding: 0.5rem 0;
  }

  /* Floating state: centered pill */
  .article-item.expanded .article-actions-container.floating {
    justify-content: center;
    padding: 1rem 0;
  }

  /* Sentinel element for sticky detection */
  .action-bar-sentinel {
    height: 1px;
    margin-top: -1px;
  }

  /* On mobile, float above the MobileBottomBar and hide on scroll */
  @media (max-width: 1000px) {
    .article-item.expanded .article-actions-container.floating {
      bottom: calc(3.5rem + env(safe-area-inset-bottom, 0px));
      transition:
        transform 0.3s ease,
        opacity 0.3s ease;
    }

    .article-item.expanded .article-actions-container.scroll-hidden {
      transform: translateY(100%);
      opacity: 0;
      pointer-events: none;
    }
  }

  /* Floating pill styles only when action bar is stuck */
  .article-item.expanded .article-actions-container.floating .article-actions {
    justify-content: space-between;
    width: auto;
    gap: 0.875rem;
    padding: 0.5rem 1rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(8px);
    border-radius: 9999px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  @media (prefers-color-scheme: dark) {
    .article-item.expanded .article-actions-container.floating .article-actions {
      background: rgba(40, 40, 40, 0.95);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    }
  }

  /* Non-floating expanded state: full-width normal bar */
  .article-item.expanded .article-actions-container:not(.floating) .article-actions {
    justify-content: space-between;
    width: 100%;
    gap: 0.75rem;
  }

  .action-btn {
    display: flex;
    align-items: center;
    white-space: nowrap;
    background: none;
    border: none;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    padding: 0.25rem 0;
    cursor: pointer;
    text-decoration: none;
  }

  .action-btn:hover {
    color: var(--color-primary, #0066cc);
  }

  .action-btn.saved {
    color: #ffc107;
  }

  .action-btn.saved:hover {
    color: #ffc107;
  }

  .action-btn.shared,
  .action-btn.active {
    color: var(--color-primary, #0066cc);
  }

  .action-btn:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .action-btn.show-more-btn,
  .action-btn.show-less-btn {
    color: var(--color-primary, #0066cc);
  }

  .action-btn.tagged {
    color: var(--color-primary, #0066cc);
  }

  .tag-count {
    font-size: 0.75rem;
    margin-left: 0.125rem;
  }

  .tag-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0 0 0.5rem;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 500;
    background: rgba(37, 99, 235, 0.08);
    color: var(--color-primary, #2563eb);
    border-radius: 999px;
  }

  .action-btn.disabled {
    color: var(--color-text-secondary);
    opacity: 0.4;
    cursor: default;
  }

  /* Overflow menu */
  .overflow-menu-wrapper {
    position: relative;
  }

  .overflow-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .overflow-menu {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    right: 0;
    z-index: 100;
    min-width: 10rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    padding: 0.25rem;
    display: flex;
    flex-direction: column;
  }

  .overflow-menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text);
    cursor: pointer;
    border-radius: 6px;
    white-space: nowrap;
    text-align: left;
  }

  .overflow-menu-item:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .overflow-menu-item.tagged {
    color: var(--color-primary, #0066cc);
  }

  @media (prefers-color-scheme: dark) {
    .overflow-menu {
      background: var(--color-bg, #1a1a1a);
      border-color: var(--color-border, #404040);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .overflow-menu-item:hover {
      background: var(--color-bg-hover, rgba(255, 255, 255, 0.08));
    }
  }

  @media (prefers-color-scheme: dark) {
    .article-item:not(.selected):not(.expanded):hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }

    .article-item:hover {
      --fade-bg: #1f1f1f;
    }

    .article-item.highlighted {
      --fade-bg: #1e2125;
    }

    .article-item.highlighted:hover {
      --fade-bg: #20252c;
    }
  }

  .action-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .action-btn.saved .action-icon :global(.icon) {
    fill: currentColor;
  }

  .action-label {
    margin-left: 0.25rem;
    font-size: 0.875rem;
  }

  /* Always-collapsed items (integrations) — hidden inline, shown in overflow */
  .action-btn.collapsible-always {
    display: none;
  }

  /* Default: hide overflow wrapper unless integrations present */
  .overflow-menu-wrapper {
    display: none;
  }

  .overflow-menu-wrapper.has-integrations {
    display: block;
    position: relative;
  }

  /* Hide Open/Tag overflow items when their inline buttons are visible */
  .overflow-menu-item.narrow-only {
    display: none;
  }

  /* Narrow: collapse Open & Tag into overflow too */
  @container (max-width: 520px) {
    .action-btn.collapsible {
      display: none;
    }
    .overflow-menu-wrapper {
      display: block;
      position: relative;
    }
    .overflow-menu-item.narrow-only {
      display: flex;
    }
  }

  /* Very narrow: hide labels too */
  @container (max-width: 300px) {
    .action-label {
      display: none;
    }
  }

  /* Mobile meta bar — hidden by default, shown on mobile when article is open */
  .article-meta-mobile {
    display: none;
  }

  /* Mobile: two-line header — [icon] [title] on top, [source] [date] below */
  @media (max-width: 600px) {
    .read-toggle {
      margin-top: calc(0.5rem + 5px);
    }

    .article-header {
      flex-wrap: wrap;
      gap: 0.25rem 0.5rem;
      /* The title takes a full-width first line; the meta items (via-pill,
         feed title, read-time, date) wrap to a second line. Center them on the
         cross axis so the via-pill's avatar shares a centerline with the small
         meta text instead of top-aligning. The title-line keeps its own
         flex-start alignment internally. */
      align-items: center;
    }

    /* Favicon + title become a full-width first line (as on desktop), so the
       source mark + feed title + meta wrap to a second line below. */
    .title-line {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      flex-basis: 100%;
      min-width: 0;
      order: 0;
    }

    .article-title {
      flex: 1 1 0;
      min-width: 0;
    }

    .feed-title-link,
    .feed-title-label {
      order: 2;
      flex: 0 1 auto;
      min-width: 0;
      font-size: 0.75rem;
      max-width: none;
    }

    .article-read-time {
      order: 3;
      display: inline;
      font-size: 0.75rem;
    }

    .article-read-time::before,
    .article-date::before {
      content: '·';
      margin-right: 0.35rem;
      color: var(--color-text-secondary);
    }

    .article-date {
      order: 4;
      font-size: 0.75rem;
    }

    /* When article is open, hide header meta and show mobile meta bar below content */
    .article-item.open .article-header .favicon,
    .article-item.open .article-header .feed-title-link,
    .article-item.open .article-header .article-date,
    .article-item.open .article-header .article-read-time {
      display: none;
    }

    .article-item.open .article-meta-mobile {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }

    .article-meta-mobile .favicon {
      order: unset;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .article-meta-mobile .feed-title-link {
      order: unset;
      flex: 0 1 auto;
      min-width: 0;
      font-size: 0.75rem;
      max-width: none;
      color: var(--color-text-secondary);
      text-decoration: none;
    }

    .article-meta-mobile .article-date {
      order: unset;
      font-size: 0.75rem;
    }

    .article-meta-mobile .article-read-time {
      order: unset;
      display: inline;
      font-size: 0.75rem;
    }
  }

  /* Mobile: bigger touch targets for expanded pill */
  @media (max-width: 480px) {
    .article-item.expanded .article-actions {
      width: 100%;
      gap: 1rem;
      padding: 0.5rem 1rem;
    }

    .article-item.expanded .action-btn {
      font-size: 1.125rem;
    }

    .article-item.expanded .action-icon :global(.icon) {
      width: 20px;
      height: 20px;
    }

    .article-item.expanded .action-label {
      font-size: 0.9375rem;
    }
  }
</style>
