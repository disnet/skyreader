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

  // The Atmosphere panel is opened from a button in the action bar; it floats
  // above the card as a scrollable overlay rather than pushing the body down.
  // Ephemeral display state, so it lives in the view.
  let atmosphereOpen = $state(false);

  // Headline numbers for the action-bar button: total references across lanes,
  // whether any lane hit its lookup cap, and whether one of them is the user's.
  const atmosphereTotal = $derived(laneRow.reduce((sum, l) => sum + l.count, 0));
  const atmosphereCapped = $derived(laneRow.some((l) => l.capped));
  const atmosphereMine = $derived(laneRow.some((l) => l.isMine));
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
        <!-- Discussion: how this link travels across the Atmosphere. The button
             carries the total reference count; tapping floats a scrollable panel
             over the card (above the bar) rather than pushing the body down. -->
        {#if laneRow.length > 0}
          <div class="atmosphere-wrapper">
            <button
              class="action-btn atmosphere-btn"
              class:active={atmosphereOpen}
              class:has-mentions={atmosphereTotal > 0}
              aria-haspopup="dialog"
              aria-expanded={atmosphereOpen}
              title={atmosphereTotal > 0
                ? `${atmosphereTotal}${atmosphereCapped ? '+' : ''} across the Atmosphere`
                : 'Add to the discussion'}
              onclick={(e) => {
                e.stopPropagation();
                atmosphereOpen = !atmosphereOpen;
              }}
            >
              <span class="action-icon"><Icon name="activity" size={16} /></span><span
                class="action-label">Discussion</span
              >{#if atmosphereTotal > 0}<span class="atmosphere-count" class:mine={atmosphereMine}
                  >{atmosphereTotal}{atmosphereCapped ? '+' : ''}</span
                >{/if}
            </button>
            {#if atmosphereOpen}
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div
                class="atmosphere-backdrop"
                onclick={(e) => {
                  e.stopPropagation();
                  atmosphereOpen = false;
                }}
              ></div>
              <div class="atmosphere-panel" role="dialog" aria-label="Discussion">
                <header class="atmosphere-panel-head">
                  <span class="atmosphere-panel-title">
                    <Icon name="activity" size={15} />
                    Discussion
                    {#if atmosphereTotal > 0}
                      <span class="atmosphere-panel-total"
                        >{atmosphereTotal}{atmosphereCapped ? '+' : ''}</span
                      >
                    {/if}
                  </span>
                  <button
                    type="button"
                    class="atmosphere-panel-close"
                    title="Close"
                    onclick={(e) => {
                      e.stopPropagation();
                      atmosphereOpen = false;
                    }}
                  >
                    <Icon name="x" size={16} />
                  </button>
                </header>
                <p class="atmosphere-panel-sub">Discussion across the Atmosphere.</p>
                <div class="atmosphere-panel-scroll">
                  {#each laneRow as row (row.id)}
                    {@const isExpanded = expandedLane === row.id}
                    <div class="lane" class:expanded={isExpanded}>
                      <button
                        type="button"
                        class="lane-row"
                        class:mine={row.isMine}
                        aria-expanded={isExpanded}
                        onclick={(e) => {
                          e.stopPropagation();
                          onToggleLane?.(row.id);
                        }}
                      >
                        <span class="lane-row-icon"><Icon name={row.icon} size={16} /></span>
                        <span class="lane-row-name">{row.label}</span>
                        {#if row.count > 0}
                          <span class="lane-row-meta"
                            ><span class="lane-row-count">{row.count}{row.capped ? '+' : ''}</span>
                            {row.verb}</span
                          >
                        {:else}
                          <span class="lane-row-add">Add yours</span>
                        {/if}
                        <span class="lane-row-chevron"
                          ><Icon
                            name={isExpanded ? 'chevron-up' : 'chevron-down'}
                            size={14}
                          /></span
                        >
                      </button>

                      {#if isExpanded && expandedLaneMeta}
                        {@const meta = expandedLaneMeta}
                        <div class="lane-body">
                          {#if expandedLaneItems?.loading}
                            <div class="lane-status">Loading…</div>
                          {:else if expandedLaneItems && expandedLaneItems.entries.length > 0}
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
                                        href={entry.url}
                                        target="_blank"
                                        rel="noopener"
                                        title="Open {meta.label}"
                                        onclick={(e) => e.stopPropagation()}
                                        ><Icon name="external-link" size={13} /></a
                                      >
                                    {/if}
                                  </div>
                                  {#if entry.note}<p class="lane-person-note">{entry.note}</p>{/if}
                                </li>
                              {/each}
                            </ul>
                          {:else if !expandedLaneItems?.loading}
                            <div class="lane-status">
                              {#if meta.canCreate}Be the first to {meta.verb} this.{:else}Nothing
                                here yet.{/if}
                            </div>
                          {/if}

                          {#if meta.canCreate}
                            <button
                              type="button"
                              class="lane-create"
                              class:done={meta.createIsEdit}
                              onclick={(e) => {
                                e.stopPropagation();
                                onCreateInLane?.(row.id);
                              }}
                            >
                              <Icon name={meta.createIsEdit ? 'edit' : 'plus'} size={14} />
                              <span>{meta.createLabel}</span>
                            </button>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
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
              class="action-label">Reader</span
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
                class="overflow-menu-item"
                onclick={(e) => {
                  e.stopPropagation();
                  onToggleRead?.();
                  onCloseOverflow?.();
                }}
              >
                <Icon name={isRead ? 'circle' : 'circle-dot'} size={16} />
                <span>{isRead ? 'Mark unread' : 'Mark read'}</span>
              </button>
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
    /* The card is its own query container, so its layout responds to the column
       width it's given (e.g. the /dev/cards width slider) rather than the
       viewport. "card" is named so descendant @container rules can target it
       explicitly past the nested action-bar container. */
    container: card / inline-size;
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

  /* The Atmosphere button + overlay panel. The button lives in the action bar
     and carries the total reference count; tapping floats a scrollable panel
     above the card. Flat and neutral per DESIGN.md — shadow appears only because
     the panel genuinely floats above the page. */
  .atmosphere-wrapper {
    position: relative;
    display: inline-flex;
  }

  .atmosphere-btn.has-mentions {
    color: var(--color-text);
  }

  /* The count rides the action-bar button: a quiet neutral pill at rest that
     picks up the One Blue on hover, when the panel is open, or when it's yours. */
  .atmosphere-count {
    margin-left: 0.3125rem;
    min-width: 1.125rem;
    padding: 0 0.375rem;
    border-radius: 999px;
    background: var(--color-bg-secondary, #f0f0f0);
    color: var(--color-text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.5;
    text-align: center;
    transition:
      color 0.15s ease,
      background-color 0.15s ease;
  }

  .atmosphere-btn:hover .atmosphere-count,
  .atmosphere-btn.active .atmosphere-count,
  .atmosphere-count.mine {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  /* Click-catcher so a tap anywhere outside the panel dismisses it. */
  .atmosphere-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .atmosphere-panel {
    position: absolute;
    bottom: calc(100% + 0.625rem);
    left: 0;
    z-index: 100;
    width: min(24rem, calc(100vw - 2rem));
    display: flex;
    flex-direction: column;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.16);
    overflow: hidden;
    transform-origin: bottom left;
    animation: atmosphere-in 0.18s cubic-bezier(0.22, 1, 0.36, 1);
  }

  @keyframes atmosphere-in {
    from {
      opacity: 0;
      transform: translateY(0.5rem) scale(0.98);
    }
  }

  /* On phones the anchored popover can't fit beside a centered action bar without
     running off-screen, so it becomes a bottom sheet: full width, slides up from
     the edge, with a light scrim. Avoids any horizontal clipping. */
  @media (max-width: 600px) {
    .atmosphere-backdrop {
      background: rgba(0, 0, 0, 0.2);
    }

    .atmosphere-panel {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      width: auto;
      border-radius: 14px 14px 0 0;
      border-bottom: none;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      transform-origin: bottom center;
      animation-name: atmosphere-sheet-in;
    }

    .atmosphere-panel-scroll {
      max-height: 60vh;
    }
  }

  @keyframes atmosphere-sheet-in {
    from {
      opacity: 0;
      transform: translateY(100%);
    }
  }

  .atmosphere-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem 0;
  }

  .atmosphere-panel-title {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .atmosphere-panel-title :global(.icon) {
    color: var(--color-text-secondary);
  }

  .atmosphere-panel-total {
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .atmosphere-panel-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    margin: -0.25rem -0.25rem 0 0;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .atmosphere-panel-close:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    color: var(--color-text);
  }

  .atmosphere-panel-sub {
    margin: 0.125rem 0 0;
    padding: 0 0.875rem 0.625rem;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .atmosphere-panel-scroll {
    max-height: min(60vh, 22rem);
    overflow-y: auto;
    border-top: 1px solid var(--color-border, #e0e0e0);
    overscroll-behavior: contain;
  }

  .lane {
    border-bottom: 1px solid var(--color-border, #e0e0e0);
  }

  .lane:last-child {
    border-bottom: none;
  }

  .lane-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.625rem 0.875rem;
    background: none;
    border: none;
    font: inherit;
    text-align: left;
    color: var(--color-text);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .lane-row:hover,
  .lane.expanded .lane-row {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .lane-row-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .lane-row.mine .lane-row-icon {
    color: var(--color-primary);
  }

  .lane-row-name {
    flex: 1;
    min-width: 0;
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .lane-row-meta {
    flex-shrink: 0;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
  }

  .lane-row-count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--color-text);
  }

  .lane-row-add {
    flex-shrink: 0;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-primary);
  }

  .lane-row-chevron {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--color-text-secondary);
    opacity: 0.6;
  }

  /* People + create affordance, indented under the lane name. */
  .lane-body {
    padding: 0 0.875rem 0.75rem 2.5rem;
  }

  .lane-status {
    padding: 0.125rem 0 0.5rem;
    font-size: 0.8125rem;
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
    font-size: 0.8125rem;
    font-weight: 600;
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
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--color-text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* The "add yours" affordance — a quiet outlined One-Blue button. */
  .lane-create {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.3125rem 0.625rem;
    background: none;
    border: 1px solid var(--color-border, #e0e0e0);
    border-radius: 6px;
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-primary, #0066cc);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;
  }

  .lane-create:hover {
    border-color: var(--color-primary);
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.08));
  }

  .lane-create.done {
    color: var(--color-text-secondary);
  }

  @media (prefers-reduced-motion: reduce) {
    .atmosphere-panel {
      animation: none;
    }
  }

  @media (prefers-color-scheme: dark) {
    .atmosphere-panel {
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }
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

  /* Mobile: [icon] [title] on the first line, then one calm meta line below —
     source · read-time · date. That meta line keeps the same fixed home whether
     the card is collapsed or open (no jumping below the body on expand).
     Keyed off the card's own width (the `card` container) so a narrow column
     gets the mobile layout regardless of viewport. */
  @container card (max-width: 600px) {
    .article-header {
      flex-wrap: wrap;
      gap: 0.25rem 0.5rem;
      /* Center the wrapped meta items on the cross axis so the via-pill's avatar
         shares a centerline with the small meta text. The title-line keeps its
         own flex-start alignment internally. */
      align-items: center;
    }

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

    /* Collapsed rows show up to two lines of the headline rather than clipping
       to one — more of the title, still a calm scan. */
    .article-item:not(.selected):not(.expanded) .article-title {
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
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

    /* Touch: every action in the bar is a comfortable one-tap target. */
    .article-actions {
      gap: 0.5rem;
    }

    .action-btn {
      min-height: 44px;
      padding-block: 0.25rem;
    }
  }

  /* Mobile: bigger touch targets for expanded pill */
  @container card (max-width: 480px) {
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
