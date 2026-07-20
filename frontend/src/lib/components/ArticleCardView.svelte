<script lang="ts">
  // PURE presentational article card. Renders entirely from props — no stores,
  // no services, no fetching $effects. All data resolution and interaction logic
  // lives in the container (ArticleCard.svelte). See articleCardView.types.ts.
  import Icon from './Icon.svelte';
  import AtmospherePanel from '$lib/components/feed/AtmospherePanel.svelte';
  import CollectionReader from '$lib/components/feed/CollectionReader.svelte';
  import { bskyEmbed } from '$lib/actions/bsky-embed';
  import { overlapShadow } from '$lib/actions/overlap-shadow';
  import type { ArticleCardViewProps } from './articleCardView.types';
  import { safeHref } from '$lib/utils/sanitize';

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
    linkPostNoteHtml,
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
    collectionPieceCount = 0,
    collection,
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
    highlights = [],
    showActionBarIntegrations = false,
    overflowMenuOpen = false,
    showFetchOriginal = false,
    showFetchOriginalMenu = false,
    fetchingOriginal = false,
    hasFetchedOriginal = false,
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
    onOpenCollectionPiece,
    onSaveCollectionPiece,
    isCollectionPieceSaved,
    onOpenLinkMenu,
    onExpandToggle,
    onTagClick,
    onOverflowClick,
    onOverflowOpenUrl,
    onFetchOriginal,
    onOverflowFetchOriginal,
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
    onMentionClick,
    onCloseOverflow,
  }: ArticleCardViewProps = $props();

  // The external URL shown beneath a link post's quote, trimmed of its scheme and
  // any trailing slash so it reads as a clean address rather than a raw href.
  const linkDisplayUrl = $derived((itemUrl ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, ''));

  // The content tap: keep the pure DOM guards here (let real links / media play),
  // then hand off the expand-vs-select decision to the container via onContentTap.
  function handleContentClick(e: MouseEvent) {
    // A @mention opens the add-feed dialog for that account (to subscribe to their
    // publications) instead of following its bsky-profile href fallback.
    const mention = (e.target as HTMLElement).closest<HTMLElement>('a[data-mention-did]');
    if (mention) {
      const did = mention.dataset.mentionDid;
      if (did) {
        e.preventDefault();
        e.stopPropagation();
        onMentionClick?.(did);
        return;
      }
    }
    if ((e.target as HTMLElement).closest('a')) return;
    if ((e.target as HTMLElement).closest('video, audio, iframe')) return;
    // A click that ends a drag-select shouldn't expand/collapse the card — let
    // the text selection stand so it can be highlighted (matters most for short
    // articles that show inline and would otherwise collapse on the same click).
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
      e.stopPropagation();
      return;
    }
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
                href={safeHref(itemUrl)}
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
        {#if collectionPieceCount > 0}
          <span
            class="edition-tag"
            title="A curated edition of {collectionPieceCount} {collectionPieceCount === 1
              ? 'piece'
              : 'pieces'}"
          >
            <Icon name="layers" size={12} />Edition · {collectionPieceCount}
          </span>
        {/if}
        {#if displayFeedTitle && !isLinkPostMode}
          {#if feedId}
            <a
              href="/feeds?feed={feedId}"
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
        <!-- A link post: the author's note as prose, then the linked article as a
             quoted snippet of its own context, then the address. Tapping the URL
             opens the in-app reader (fetched on demand). -->
        {#if linkPostNoteHtml}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <div class="link-post-note">{@html linkPostNoteHtml}</div>
        {/if}
        {#if linkPostExcerpt}
          <blockquote class="link-post-quote">{linkPostExcerpt}</blockquote>
        {/if}
        <button
          class="link-post-url"
          title={itemUrl}
          onclick={(e) => {
            e.stopPropagation();
            onOpenLinkMenu?.(e.currentTarget.getBoundingClientRect());
          }}
        >
          {#if faviconUrl}<img src={faviconUrl} alt="" class="link-post-url-favicon" />{/if}
          <span class="link-post-url-text">{linkDisplayUrl}</span>
          <Icon name="external-link" size={13} />
        </button>
      {:else if collection}
        <!-- A curated edition: render its pieces as embedded cards (the same
             CollectionReader the fullscreen reader uses), so the river and the
             reader show the edition identically. -->
        <div class="article-body-wrapper" class:has-fade={selected && !expanded && isTruncated}>
          <!-- .collection-host (not .article-body): the prose globals (p/ol/li/
               blockquote margins) would otherwise bleed into the edition's card
               layout. Keeps the clamp behavior for the collapsed preview.
               `inert` while clamped: the line-clamp visually hides the lower
               pieces' Save/Open buttons but leaves them tab-focusable + clickable,
               so the collapsed preview reads as a pure teaser (expand to act). -->
          <div
            bind:this={bodyEl}
            class="collection-host"
            class:truncated={selected && !expanded}
            inert={selected && !expanded}
          >
            <CollectionReader
              {collection}
              onOpenPiece={onOpenCollectionPiece}
              onSavePiece={onSaveCollectionPiece}
              isPieceSaved={isCollectionPieceSaved}
            />
          </div>
        </div>
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
        <!-- When the feed only gave us a short excerpt, offer to pull the full
             article inline. Hidden once the body is long (full-content feeds)
             or already fetched. Sits at the end of the body, not in the ⋯ menu,
             so it reads as a natural "continue reading" affordance. Hidden while
             the collapsed preview is clamped — you can't reach the body's end. -->
        {#if showFetchOriginal && !(selected && !expanded && isTruncated)}
          <button
            class="fetch-original"
            disabled={fetchingOriginal}
            onclick={(e) => {
              e.stopPropagation();
              onFetchOriginal?.();
            }}
          >
            <Icon name="file-text" size={15} />
            <span>{fetchingOriginal ? 'Fetching full article…' : 'Fetch full article'}</span>
          </button>
        {/if}
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
      <!-- The shared-note box + Discussion lanes, in flow above the action row so
           they ride the same sticky band. The note box shows whenever shared; the
           lanes only when Discussion is toggled (panelOpen). -->
      <AtmospherePanel
        {laneRow}
        {expandedLane}
        {expandedLaneItems}
        {currentlyShared}
        {currentNote}
        {highlights}
        lanesOpen={panelOpen}
        panelId="discussion-panel"
        {onToggleLane}
        {onCreateInLane}
        {onApplyComment}
        {onOpenAuthor}
      />
      <div class="article-actions">
        <!-- Save button. Label tracks state ("Save" → "Saved") and the bookmark
             fills green, so the confirmation persists rather than relying on a
             subtle color shift the user might miss. -->
        <button
          class="action-btn"
          class:saved={isSaved}
          title={isSaved ? 'Saved to read later. Tap to remove' : 'Save to read later'}
          onclick={(e) => {
            e.stopPropagation();
            onToggleSave?.();
          }}
        >
          <span class="action-icon"><Icon name="bookmark" size={16} /></span><span
            class="action-label">{isSaved ? 'Saved' : 'Save'}</span
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
              title={currentlyShared
                ? 'Shared to your linkblog. Tap to remove'
                : (shareRow?.createLabel ?? 'Share to your linkblog')}
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
        {#if hasOpenFullscreen && (hasContent || collectionPieceCount > 0)}
          <button
            class="action-btn"
            onclick={(e) => {
              e.stopPropagation();
              onOpenFullscreen?.();
            }}
          >
            <span class="action-icon"><Icon name="maximize" size={16} /></span><span
              class="action-label">{collectionPieceCount > 0 ? 'Open edition' : 'Reader'}</span
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
              {#if showFetchOriginalMenu}
                <!-- Long-body / full-content articles get the fetch action here
                     rather than the prominent end-of-body nudge reserved for
                     short excerpts. Lets the reader force a clean re-extraction. -->
                <button
                  class="overflow-menu-item"
                  disabled={fetchingOriginal}
                  onclick={(e) => {
                    e.stopPropagation();
                    onOverflowFetchOriginal?.();
                  }}
                >
                  <Icon name="file-text" size={16} />
                  <span>{fetchingOriginal ? 'Fetching full article…' : 'Fetch full article'}</span>
                </button>
              {/if}
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
                  <span>Add source</span>
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
    font-size: var(--text-sm);
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

  /* A curated edition reads as an ordinary article row — same favicon, title,
     meta, and action bar — with one quiet marker that it gathers many pieces.
     One Blue + the layers glyph (color never alone) make it the single colour
     event on the row; flat, no bespoke card. Aligns to the title's first line
     so it rides the meta cluster cleanly past the header's baseline. */
  .edition-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
    /* Ride the meta row's shared text baseline (like .via-pill) rather than
       centering in the taller title line box — otherwise the pill floats above
       the feed/date text beside it. The wash stays optically centered on the
       text because the padding is symmetric and the glyph matches the cap height. */
    align-self: baseline;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-normal, 1.5);
    color: var(--color-primary, #0066cc);
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    white-space: nowrap;
  }

  /* Pull the layers glyph onto the text baseline so it centers with the label
     inside the pill (svgs have no baseline of their own). */
  .edition-tag :global(.icon) {
    vertical-align: -0.15em;
  }

  /* A read edition mutes with the rest of the row rather than holding its blue. */
  .article-item.read .edition-tag {
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, rgba(128, 128, 128, 0.1));
  }

  /* Link-post body: the note as prose, then the article as a tappable card. */
  /* The author's note, rendered from Markdown. Block children (paragraphs,
     lists) collapse their outer margins so the note reads as one tight block. */
  .link-post-note {
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: 1.7;
    color: var(--color-text);
    margin: 0 0 1rem;
    overflow-wrap: break-word;
  }

  .link-post-note :global(> :first-child) {
    margin-top: 0;
  }

  .link-post-note :global(> :last-child) {
    margin-bottom: 0;
  }

  .link-post-note :global(p) {
    margin: 0 0 0.75rem;
  }

  .link-post-note :global(a) {
    color: var(--color-primary, #0066cc);
  }

  .link-post-note :global(ul),
  .link-post-note :global(ol) {
    margin: 0 0 0.75rem;
    padding-left: 1.5rem;
  }

  .link-post-note :global(li) {
    margin: 0.125rem 0;
  }

  /* A Markdown quote inside the note — the article's own words, seeded into the
     editable note when sharing. Matches the standalone .link-post-quote so the
     quote reads the same however it got there: quiet left rule, secondary text,
     subordinate to the commentary around it. */
  .link-post-note :global(blockquote) {
    margin: 0 0 0.75rem;
    padding: 0.125rem 0 0.125rem 1rem;
    border-left: 3px solid var(--color-border, #e5e5e5);
    color: var(--color-text-secondary);
  }

  /* The quote's own paragraphs shouldn't add trailing space inside the rule. */
  .link-post-note :global(blockquote > :last-child) {
    margin-bottom: 0;
  }

  .link-post-note :global(code) {
    font-family: var(--font-mono, monospace);
    font-size: 0.9em;
    background: var(--color-surface-2, #f3f3f3);
    padding: 0.1em 0.3em;
    border-radius: 4px;
  }

  .link-post-note :global(pre) {
    margin: 0 0 0.75rem;
    padding: 0.75rem;
    overflow-x: auto;
    background: var(--color-surface-2, #f3f3f3);
    border-radius: 6px;
  }

  .link-post-note :global(pre code) {
    background: none;
    padding: 0;
  }

  /* The linked article's own context, quoted. A quiet left rule and secondary
     text keep it subordinate to the author's note above — it's the article
     speaking, not the linkblogger. */
  .link-post-quote {
    margin: 0 0 1rem;
    padding: 0.125rem 0 0.125rem 1rem;
    border-left: 3px solid var(--color-border, #e5e5e5);
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: 1.6;
    color: var(--color-text-secondary);
    overflow-wrap: break-word;
  }

  /* The address, as a plain link rather than a card. One Blue, favicon for
     provenance, external-link glyph to signal it opens the article. */
  .link-post-url {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    max-width: 100%;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: var(--text-sm);
    color: var(--color-primary, #0066cc);
    cursor: pointer;
    text-align: left;
  }

  .link-post-url:hover .link-post-url-text {
    text-decoration: underline;
  }

  .link-post-url-favicon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .link-post-url-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
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
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-normal);
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

  .link-post-context {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0 0 0.75rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--color-border, #e8e8e8);
    font-size: var(--text-sm);
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
    line-height: var(--leading-snug);
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
    /* Baseline, not flex-start: the title is --text-base while the meta
       (Shared by / feed / date) is the smaller --text-sm, so their line boxes
       differ. Aligning baselines puts all the text on one line; flex-start
       would let the smaller meta ride ~4px high. The favicon opts back out
       below (it centers on the title line instead). */
    align-items: baseline;
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
    /* Opt out of the header's baseline alignment and center the 16px favicon
       within the first line of the title instead. The title is a fixed
       --text-base at line-height 1.5, so matching those metrics here makes 1lh
       resolve to that line box — centering stays correct even when the title
       wraps to multiple lines. */
    align-self: flex-start;
    font-size: var(--text-base);
    line-height: var(--leading-normal);
    margin-top: calc((1lh - 16px) / 2);
  }

  /* The title is chrome, not reading content: it shares the header row with the
     fixed-size meta (Shared by / date / feed / read-time, all --text-sm), so it
     stays a fixed UI size rather than tracking the user's article-font choice —
     otherwise a bumped article size desyncs the title from its own meta row.
     Reading customization applies to the body (.article-body / .link-post-*). */
  .article-title {
    flex: 1;
    font-family: var(--font-sans-serif);
    font-size: var(--text-base);
    font-weight: var(--weight-regular);
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
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
  }

  .article-read-time {
    flex-shrink: 0;
    font-size: var(--text-sm);
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
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .feed-title-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .article-content {
    padding: 0;
    /* Text cursor: the body is selectable/highlightable, not a single click
       target. Expanding is done via the explicit "More" affordance. */
    cursor: text;
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

  /* Host for a curated edition's pieces. Bare on purpose — CollectionReader owns
     its own typography, and staying off .article-body avoids the prose globals
     bleeding into the card layout. Keeps the collapsed-preview clamp. */
  .collection-host {
    position: relative;
  }

  .collection-host.truncated {
    display: -webkit-box;
    -webkit-line-clamp: 8;
    line-clamp: 8;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .article-body {
    position: relative;
    font-family: var(--article-font);
    font-size: var(--article-font-size);
    line-height: 1.7;
    color: var(--color-text);
    overflow-wrap: break-word;
  }

  /* "Fetch full article" — a quiet inline affordance at the end of a short
     excerpt. Muted secondary text so it recedes; the interaction blue is
     reserved for primary actions. Deepens to full text color on hover. */
  .fetch-original {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.75rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    cursor: pointer;
  }

  .fetch-original:hover:not(:disabled) {
    color: var(--color-text);
  }

  .fetch-original:disabled {
    cursor: default;
    opacity: 0.7;
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

  .article-body :global(img),
  .article-body :global(svg) {
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
    font-size: var(--text-sm);
  }

  .article-body :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }

  /* Native MathML. Display equations get their own line and scroll rather than
     forcing the column wider; inline math just rides along with the text. */
  .article-body :global(math[display='block']) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    margin: 0.75rem 0;
    padding-bottom: 0.25rem;
  }

  .article-body :global(math) {
    max-width: 100%;
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
    font-size: var(--text-md);
    color: var(--color-text-secondary);
    padding: 0.25rem 0;
    cursor: pointer;
    text-decoration: none;
  }

  .action-btn:hover {
    color: var(--color-primary, #0066cc);
  }

  /* Saved/Shared is a confirmed, positive state — success green (not the warning
     amber it used to borrow), so "I've done the thing" reads at a glance. */
  .action-btn.saved {
    color: var(--color-success, #4caf50);
  }

  .action-btn.saved:hover {
    color: var(--color-success, #4caf50);
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
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
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
    font-size: var(--text-md);
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
    font-size: var(--text-sm);
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
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
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
    font-size: var(--text-md);
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
    .read-toggle {
      margin-top: calc(0.5rem + 5px);
    }

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

    .edition-tag {
      order: 1;
      font-size: var(--text-xs);
    }

    .feed-title-link,
    .feed-title-label {
      order: 2;
      flex: 0 1 auto;
      min-width: 0;
      font-size: var(--text-xs);
      max-width: none;
    }

    .article-read-time {
      order: 3;
      display: inline;
      font-size: var(--text-xs);
    }

    .article-read-time::before,
    .article-date::before {
      content: '·';
      margin-right: 0.35rem;
      color: var(--color-text-secondary);
    }

    .article-date {
      order: 4;
      font-size: var(--text-xs);
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
      font-size: var(--text-xl);
    }
  }
</style>
