<script lang="ts">
  // PURE presentational article card. Renders entirely from props — no stores,
  // no services, no fetching $effects. All data resolution and interaction logic
  // lives in the container (ArticleCard.svelte). See articleCardView.types.ts.
  import Icon from './Icon.svelte';
  import ShareCommentBox from '$lib/components/feed/ShareCommentBox.svelte';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import { overlapShadow } from '$lib/actions/overlap-shadow';
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
    showActionBarIntegrations = false,
    overflowMenuOpen = false,
    canFollowSource = false,
    hasSaveToSemble = false,
    hasSaveToMargin = false,
    hasOpenFullscreen = false,
    // bindings
    bodyEl = $bindable(),
    tagBtnRef = $bindable(),
    overflowTriggerRef = $bindable(),
    // callbacks
    onHeaderClick,
    onContentTap,
    onToggleRead,
    onToggleSave,
    onRemoveShare,
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

  // The Discussion lanes are toggled from a button in the action bar. They render
  // in flow inside the sticky footer (above the action row), so opening them grows
  // the pinned footer upward rather than scrolling the card. Ephemeral display
  // state, so it lives in the view.
  let atmosphereOpen = $state(false);

  // Whether the sticky action bar is currently pinned over scrolling content
  // (vs. resting at the card's natural bottom). Driven by the overlapShadow
  // action on the sentinel below the bar — presentation behavior the view owns,
  // so it stays testable from /dev/cards without the container.
  let actionBarFloating = $state(false);

  // Headline numbers for the action-bar button: total references across lanes,
  // whether any lane hit its lookup cap, and whether one of them is the user's.
  const atmosphereTotal = $derived(laneRow.reduce((sum, l) => sum + l.count, 0));
  const atmosphereCapped = $derived(laneRow.some((l) => l.capped));
  const atmosphereMine = $derived(laneRow.some((l) => l.isMine));

  // The action-bar Share button is a toggle for the Blogs lane: when not yet
  // shared it runs the same create path as the lane's [+] (createInLane), and
  // once shared it removes the share (the same as the note box's Remove). It
  // shows whenever sharing is possible at all — the lane offers a create OR the
  // item is already shared — so pressing it never makes the button vanish.
  const shareRow = $derived(laneRow.find((l) => l.id === 'linkblog'));
  const canShare = $derived(Boolean(shareRow?.canCreate) || currentlyShared);

  // Removing a share is a small destructive step (it deletes a PDS record), so
  // the Share toggle asks for an inline confirm rather than removing on first
  // click. Reset whenever the card closes or its shared state changes.
  let confirmingRemove = $state(false);
  $effect(() => {
    if (!isOpen || !currentlyShared) confirmingRemove = false;
  });

  // Are the Discussion lanes rendered? Gated on the toggle plus having lanes to
  // show. The shared-note box is NOT gated on this — it shows whenever the item is
  // shared (just above the lanes), so the note stays put as Discussion opens and
  // closes beneath it.
  let panelOpen = $derived(atmosphereOpen && laneRow.length > 0);
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
    {#if isLinkPostMode && socialContext && (socialContext.quoteCount > 0 || alsoLinkedBy.length > 0)}
      <div class="link-post-context">
        {#if socialContext.quoteCount > 0}
          <span class="context-stat">
            {socialContext.quoteCount}
            {socialContext.quoteCount === 1 ? 'quote' : 'quotes'}
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

    <!-- The action bar's container is the sticky footer: when expanded it pins to
         the bottom of the viewport while the article scrolls behind it, then
         slides flat into the card's end once you reach the bottom. The Discussion
         area (note + lanes) lives INSIDE it, above the action row, so it rides the
         same sticky band — opening it grows the band upward from the bar (no
         scroll), and while floating the whole stack reads as one footer:

           …article body
           ── drop shadow ──
           [ note ]
           [ discussion lanes ]
           [ action row ]
    -->
    <div class="article-actions-container" class:floating={actionBarFloating}>
      {#if currentlyShared}
        <!-- Your note on a shared item: always shown while shared (not gated on
             the Discussion panel), so the note box is there to read or edit the
             moment you share. A fixed slot (min-height) keeps its metrics constant
             whether or not a lane is expanded below, so it never jumps. -->
        <div class="atmosphere-lead">
          <ShareCommentBox
            initialNote={currentNote ?? ''}
            placeholder="Add a note to your share…"
            onsubmit={(note) => onApplyComment?.(note)}
          />
        </div>
      {/if}
      {#if panelOpen}
        <div class="atmosphere-panel" id="discussion-panel" role="region" aria-label="Discussion">
          <!-- Lanes as a tab strip: each lane is a select-toggle chip carrying
                 its count, paired with its own [+] create. Picking a tab reveals
                 that lane's posts in the panel below; picking the active tab again
                 closes it. One lane open at a time (the active tab). -->
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
                {:else if !expandedLaneItems?.loading}
                  <div class="lane-status">Nothing here yet.</div>
                {/if}
              </div>
            {/if}
          {/if}
        </div>
      {/if}
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
        <!-- Share: a toggle for the Blogs lane, surfaced in the bar so sharing is
             one tap from the card. Not shared → the same create path as the
             lane's [+]; already shared → remove the share. Reads active while
             shared (the Discussion note box still owns editing the note). -->
        {#if canShare}
          <div class="share-btn-wrapper">
            <button
              class="action-btn share-btn"
              class:saved={currentlyShared}
              class:confirming={confirmingRemove}
              title={currentlyShared ? 'Remove share' : shareRow?.createLabel}
              onclick={(e) => {
                e.stopPropagation();
                if (currentlyShared) confirmingRemove = !confirmingRemove;
                else onCreateInLane?.('linkblog');
              }}
            >
              <span class="action-icon"><Icon name="share" size={16} /></span><span
                class="action-label">{currentlyShared ? 'Shared' : 'Share'}</span
              >
            </button>
            {#if confirmingRemove}
              <!-- Confirm popover above the button, so it works even when the
                   action bar collapses to icon-only on small viewports. -->
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div class="overflow-backdrop" onclick={() => (confirmingRemove = false)}></div>
              <div class="confirm-pop">
                <p class="confirm-pop-title">Remove this share?</p>
                <div class="confirm-pop-actions">
                  <button
                    class="confirm-pop-btn cancel"
                    onclick={(e) => {
                      e.stopPropagation();
                      confirmingRemove = false;
                    }}>Cancel</button
                  >
                  <button
                    class="confirm-pop-btn danger"
                    onclick={(e) => {
                      e.stopPropagation();
                      confirmingRemove = false;
                      onRemoveShare?.();
                    }}>Remove</button
                  >
                </div>
              </div>
            {/if}
          </div>
        {/if}
        <!-- Discussion: the social hub. The total reference count rides the
             button, which reads active while open and tints when one of those
             references is yours. -->
        {#if laneRow.length > 0}
          <button
            class="action-btn atmosphere-btn"
            class:active={atmosphereOpen}
            class:has-mentions={atmosphereTotal > 0}
            aria-expanded={atmosphereOpen}
            aria-controls="discussion-panel"
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
        <!-- Inline open — visible when there's space, hidden when narrow.
             Read & Tag live in the overflow menu instead (always). -->
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
        <!-- Overflow menu: always present — it's the permanent home for Read &
             Tag, plus Open-in-browser (narrow only), integrations, and follow. -->
        <div class="overflow-menu-wrapper">
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
                <Icon name={isRead ? 'circle' : 'check'} size={16} />
                <span>{isRead ? 'Mark unread' : 'Mark read'}</span>
              </button>
              <button
                class="overflow-menu-item"
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
    {#if expanded}<div
        class="action-bar-sentinel"
        use:overlapShadow={{
          onChange: (v) => {
            actionBarFloating = v;
          },
        }}
      ></div>{/if}

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

  /* The Discussion button + in-flow section. The button lives in the action bar;
     tapping reveals a flat section that sits directly above the bar as a genuine
     part of the card (1px dividers top and bottom, no shadow, no radius — flat
     per DESIGN.md). Opening it scrolls the bar to the bottom of the view so the
     article above is pushed up (see the scroll effect in the script). */
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

  /* The note box and lanes are in-flow children of the sticky action-bar
     container, stacked above the action row. Because they share the container they
     ride the same sticky band — aligned to the article's content edge (no surface
     of their own), with the band's ::before painting the opaque footer + top drop
     shadow over them while floating, so note + lanes + bar read as one pinned
     footer. The note box shows whenever shared; the lanes only when Discussion is
     toggled. */
  .atmosphere-panel {
    display: flex;
    flex-direction: column;
  }

  /* Your-note box, the Discussion area's lead once shared. A fixed slot
     (min-height) keeps its metrics constant whether or not a lane is expanded
     below, so the note never shifts; the box grows past the floor once it wraps. */
  .atmosphere-lead {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 3.25rem;
  }

  /* The note box fills the slot width; drop its own top margin so the slot's
     centering is symmetric, and its horizontal padding so the note icon aligns
     to the same content edge as the lanes and the article body. */
  .atmosphere-lead :global(.comment-box) {
    margin-top: 0;
    padding-left: 0;
    padding-right: 0;
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
    font-size: 0.8125rem;
    font-weight: 500;
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
    font-weight: 600;
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
    /* Center the 16px favicon within the first line of the title. The title
       inherits line-height 1.5 at var(--article-font-size), so matching those
       metrics here makes 1lh resolve to that line box — keeping alignment
       correct as the user changes article font size (instead of a fixed nudge). */
    font-size: var(--article-font-size);
    line-height: 1.5;
    margin-top: calc((1lh - 16px) / 2);
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

  /* When a read article is open its title renders as a link (blue), which would
     otherwise override the read-mute. Keep the same muted signal as the collapsed
     row so "already read" stays legible once expanded. */
  .article-item.read .article-title-link {
    color: var(--color-text-secondary);
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
    font-size: 0.8rem;
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

  /* Zero the leading/trailing margin of WHATEVER element starts/ends the body,
     not just <p>. The truncated (selected) body is a BFC (flow-root via
     line-clamp) so a first child's top margin is contained; the expanded body is
     plain block, where that same margin collapses out and up. If the first child
     is an <h2>/<figure>/<ul>/<blockquote> with a top margin, that mismatch makes
     the text jump on expand. Forcing the edge margins to 0 keeps the top stable.
     The read-progress highlight is injected into the body-wrapper, not the body,
     so it never displaces these first/last content children. */
  .article-body :global(> :first-child) {
    margin-top: 0;
  }

  .article-body :global(> :last-child) {
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
    flex-direction: column;
    container-type: inline-size;
    padding: 0.125rem 0 0.25rem;
  }

  /* Inline style: flat row integrated into card bottom */
  .article-actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: 0.75rem;
    padding: 0.25rem 0;
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

  /* Expanded: the bar stays pinned to the bottom of the viewport while the card
     bottom is still below the fold. It keeps its normal full-width layout in
     every state — no pill morph.

     The footer band is painted by ::before so it can bleed edge-to-edge (past
     the card's 1rem padding) without changing the bar's box or its
     container-query width. `isolation` makes that band paint above the article
     scrolling beneath the sticky bar, but behind the controls. */
  .article-item.expanded .article-actions-container {
    /* Gap between the floating bar and the viewport bottom, so the bar reads as a
       rounded card edge that floats above the page rather than sitting flush. The
       ::after mask is extended down by the same amount to fill the gap with page
       background (mobile folds the safe-area inset into it). */
    --float-below: 0.5rem;
    /* Extra lift so the floating bar clears the fixed mobile nav and stacks above
       it. 0 on desktop and while the nav is hidden; set on mobile (see below). */
    --float-lift: 0px;
    position: sticky;
    bottom: calc(var(--float-below) + var(--float-lift));
    padding: 0.375rem 0;
    isolation: isolate;
    transition:
      transform 0.3s ease,
      opacity 0.3s ease,
      bottom 0.3s ease;
  }

  /* Transparent at rest, so the bar inherits the card's own background (incl.
     the hover / highlight tint) and reads as flat — part of the card. While it
     overlaps scrolling content ("floating") the band becomes a contrasting
     edge-to-edge footer with a top hairline + depth shadow, so the article
     clearly scrolls behind the bottom of the card. Both resolve back to flat
     once the card's end is reached. */
  .article-item.expanded .article-actions-container::before {
    content: '';
    position: absolute;
    inset: 0 -1rem;
    z-index: -1;
    background: transparent;
    box-shadow:
      0 -1px 0 rgba(0, 0, 0, 0),
      0 -8px 16px -10px rgba(0, 0, 0, 0);
    transition:
      background-color 0.2s ease,
      box-shadow 0.2s ease;
    pointer-events: none;
  }

  .article-item.expanded .article-actions-container.floating::before {
    background: var(--color-bg-secondary, #f5f5f5);
    /* Round the bottom to match the card's own 8px radius, so the floating bar
       reads as the card's bottom edge rather than a control overlaying it. The
       ::after mask below keeps scrolling content from peeking through the notch
       the rounding leaves in each corner. */
    border-radius: 0 0 8px 8px;
    box-shadow:
      0 -1px 0 var(--color-border, #e0e0e0),
      0 -8px 16px -10px rgba(0, 0, 0, 0.18);
  }

  /* Page-background fill one layer behind the footer band. Where the band's
     rounded corners cut away, this shows through — so the corner notch reveals
     the page the card sits on, not the article scrolling underneath. It lives in
     the same isolated stacking context as the band, so it still paints above the
     scrolling content. */
  .article-item.expanded .article-actions-container.floating::after {
    content: '';
    position: absolute;
    /* Extends past the band's bottom by the gap + the nav's full height, so the
       page fills everything below the bar down to (and past) the viewport edge —
       masking the article text scrolling behind the fixed nav so it can't peek
       through the nav's translucent pills. Uses the constant --bottom-bar-height
       rather than the animating --float-lift on purpose: the bar's `bottom`
       transitions over 0.3s, so a fill that retracted in lockstep would briefly
       expose text mid-animation. A constant (over-)extension always covers. */
    inset: 0 -1rem calc(-1 * (var(--float-below) + var(--bottom-bar-height))) -1rem;
    z-index: -2;
    background: var(--color-bg, #ffffff);
    pointer-events: none;
  }

  @media (prefers-color-scheme: dark) {
    .article-item.expanded .article-actions-container.floating::before {
      background: var(--color-bg-secondary, #2a2a2a);
      box-shadow:
        0 -1px 0 var(--color-border, #333),
        0 -8px 16px -10px rgba(0, 0, 0, 0.6);
    }

    .article-item.expanded .article-actions-container.floating::after {
      background: var(--color-bg, #1a1a1a);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .article-item.expanded .article-actions-container,
    .article-item.expanded .article-actions-container::before {
      transition: none;
    }
  }

  /* Sentinel element for sticky detection */
  .action-bar-sentinel {
    height: 1px;
    margin-top: -1px;
  }

  /* On mobile the floating bar reads as the card's bottom edge. It stays put
     through scrolling — it's the card's own bottom, not a control that hides on
     scroll. It lifts above the fixed MobileBottomBar (which keeps its normal spot
     flush to the viewport edge) by the nav's height, so the two stack instead of
     overlapping; `--mobile-nav-lift` drops back to 0 when the nav hides, letting
     the bar settle to the bottom. Folding the safe-area inset into the float gap
     floats the bar clear of the home indicator when the nav is gone. */
  @media (max-width: 1000px) {
    .article-item.expanded .article-actions-container.floating {
      --float-below: calc(0.5rem + env(safe-area-inset-bottom, 0px));
      --float-lift: var(--mobile-nav-lift, 0px);
    }

    /* Tighter floating band on mobile, where screen space is scarce. The
       non-floating bar already reads fine; only the pinned footer needs trimming. */
    .article-item.expanded .article-actions-container.floating {
      padding: 0.125rem 0;
    }

    .article-item.expanded .article-actions-container.floating .article-actions {
      padding: 0;
    }
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

  /* The Share toggle borrows the saved-state yellow but stays stroke-only — the
     bookmark fills, the share icon doesn't. */
  .action-btn.share-btn.saved .action-icon :global(.icon) {
    fill: none;
  }

  /* Confirm-remove popover, anchored above the Share button (mirrors the
     overflow menu) so it never depends on inline space in the action bar. */
  .share-btn-wrapper {
    position: relative;
    display: inline-flex;
  }

  .confirm-pop {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 0;
    z-index: 100;
    min-width: 12rem;
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    padding: 0.625rem 0.75rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .confirm-pop-title {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--color-text);
    white-space: nowrap;
  }

  .confirm-pop-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .confirm-pop-btn {
    padding: 0.3125rem 0.75rem;
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid var(--color-border, #e5e7eb);
    background: none;
    color: var(--color-text);
  }

  .confirm-pop-btn.cancel:hover {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .confirm-pop-btn.danger {
    background: var(--color-danger, #c0392b);
    border-color: transparent;
    color: #fff;
  }

  .confirm-pop-btn.danger:hover {
    opacity: 0.9;
  }

  @media (prefers-color-scheme: dark) {
    .confirm-pop {
      background: var(--color-bg, #1a1a1a);
      border-color: var(--color-border, #404040);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .confirm-pop-btn.cancel:hover {
      background: var(--color-bg-hover, rgba(255, 255, 255, 0.08));
    }
  }

  .action-label {
    margin-left: 0.25rem;
    font-size: 0.875rem;
  }

  /* Always-collapsed items (integrations) — hidden inline, shown in overflow */
  .action-btn.collapsible-always {
    display: none;
  }

  /* Overflow is always present — it's the permanent home for Read & Tag. */
  .overflow-menu-wrapper {
    display: block;
    position: relative;
  }

  /* Open-in-browser duplicates the inline Open button, so it only shows in the
     menu once that inline button has collapsed (narrow). */
  .overflow-menu-item.narrow-only {
    display: none;
  }

  /* Narrow: collapse the inline Open button into the overflow menu (revealing the
     menu's Open-in-browser item), and drop every label so the remaining buttons
     (Save, Share, Discussion, Reader, overflow, More) go icon-only instead of
     overflowing their row. The labeled set is ~480px wide, so it won't fit a
     phone-width card — icon-only has to kick in here, not at some narrower width. */
  @container (max-width: 520px) {
    .action-btn.collapsible {
      display: none;
    }
    .overflow-menu-item.narrow-only {
      display: flex;
    }
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

  /* Mobile: bigger touch targets for the expanded action bar */
  @container card (max-width: 480px) {
    .article-item.expanded .article-actions {
      width: 100%;
      gap: 1rem;
      padding: 0.5rem 1rem;
    }

    .article-item.expanded .action-btn {
      font-size: 1.125rem;
    }
  }
</style>
