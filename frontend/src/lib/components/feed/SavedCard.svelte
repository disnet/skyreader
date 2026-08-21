<script lang="ts">
  import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
  import { formatRelativeDate } from '$lib/utils/date';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import { savesStore } from '$lib/stores/saves.svelte';
  import { linkblogStore } from '$lib/stores/linkblog.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { preferences } from '$lib/stores/preferences.svelte';
  import { shareComposerStore } from '$lib/stores/shareComposer.svelte';
  import { shareDraftsStore } from '$lib/stores/shareDrafts.svelte';
  import type { Article } from '$lib/types';
  import { db } from '$lib/services/db';
  import { decodeEntities } from '$lib/utils/entities';
  import Icon from '$lib/components/Icon.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import TagMenu from '$lib/components/feed/TagMenu.svelte';

  let {
    displayItem,
    selected = false,
    onOpen,
    onArchive,
    onRemove,
    onHover,
    onSaveToSemble,
    onSaveToMargin,
  }: {
    displayItem: FeedDisplayItem;
    selected?: boolean;
    onOpen?: () => void;
    onArchive?: () => void;
    onRemove?: () => void;
    onHover?: () => void;
    onSaveToSemble?: () => void;
    onSaveToMargin?: () => void;
  } = $props();

  // Normalize data across item types
  let itemKey = $derived(displayItem.key);
  let itemType = $derived(displayItem.type);

  let title = $derived.by(() => {
    if (displayItem.type === 'article')
      return decodeEntities(displayItem.item.title) || displayItem.item.url;
    if (displayItem.type === 'document')
      return decodeEntities(displayItem.item.title) || displayItem.item.recordUri;
    if (displayItem.type === 'saved')
      return decodeEntities(displayItem.item.title) || displayItem.item.url;
    return '';
  });

  let url = $derived.by(() => {
    if (displayItem.type === 'article') return displayItem.item.url;
    if (displayItem.type === 'document')
      return displayItem.item.canonicalUrl || displayItem.item.path || '';
    if (displayItem.type === 'saved') return displayItem.item.url;
    return '';
  });

  let publishedAt = $derived.by(() => {
    if (displayItem.type === 'article') return displayItem.item.publishedAt;
    if (displayItem.type === 'document') return displayItem.item.publishedAt;
    if (displayItem.type === 'saved') return displayItem.item.savedAt;
    return '';
  });

  // Feed info (for articles only)
  let sub = $derived(
    displayItem.type === 'article'
      ? subscriptionsStore.subscriptions.find((s) => s.id === displayItem.item.subscriptionId)
      : undefined
  );
  let feedTitle = $derived.by(() => {
    if (displayItem.type === 'article') return sub?.customTitle || sub?.title || '';
    // Documents (standard.site): show publication hostname like a normal feed item
    if (displayItem.type === 'document') {
      const docUrl = displayItem.item.canonicalUrl || displayItem.item.siteUri;
      if (docUrl) {
        try {
          return new URL(docUrl).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      }
    }
    return '';
  });

  let faviconUrl = $derived.by(() => {
    if (displayItem.type === 'article') {
      return getFaviconUrl(sub?.siteUrl || sub?.feedUrl || displayItem.item.url);
    }
    if (displayItem.type === 'document' && displayItem.item.siteIcon) {
      return displayItem.item.siteIcon;
    }
    if (displayItem.type === 'document' && displayItem.item.canonicalUrl) {
      return getFaviconUrl(displayItem.item.canonicalUrl);
    }
    if (displayItem.type === 'saved') {
      return getFaviconUrl(displayItem.item.url);
    }
    return url ? getFaviconUrl(url) : '';
  });

  let isArchived = $derived(itemLabelsStore.isArchived(itemKey));
  let tags = $derived(itemLabelsStore.getTagsForItem(itemKey));

  // Saved "light" items carry `content: null` in memory, so when their stored
  // wordCount is missing we pull the body back from IndexedDB to count it rather
  // than falling back to the short RSS `description` (which produced a misleading
  // "1 min"). Only runs for saved items that lack a precomputed wordCount; most
  // self-heal via the store's backfill before this is ever needed.
  let lazyWordCount = $state<number | null>(null);
  $effect(() => {
    if (displayItem.type !== 'saved' || displayItem.item.wordCount) {
      lazyWordCount = null;
      return;
    }
    const rkey = displayItem.item.rkey;
    let cancelled = false;
    (async () => {
      let body = '';
      try {
        body = (await savesStore.getContent(rkey)) || '';
      } catch {
        // Best effort — leave the count unknown and hide the chip.
      }
      if (cancelled) return;
      const text = body.replace(/<[^>]*>/g, '');
      const count = text.split(/\s+/).filter(Boolean).length;
      lazyWordCount = count || null;
    })();
    return () => {
      cancelled = true;
    };
  });

  // Estimate read time from word count (~200 words/min). Returns null — and the
  // chip is hidden — when there's genuinely no text to estimate from, which beats
  // showing a misleading "1 min".
  let readTimeMinutes = $derived.by((): number | null => {
    let wordCount: number | null = null;
    if (displayItem.type === 'article') {
      wordCount = displayItem.item.wordCount ?? null;
      if (wordCount == null) {
        const text = (displayItem.item.content || displayItem.item.summary || '').replace(
          /<[^>]*>/g,
          ''
        );
        wordCount = text.split(/\s+/).filter(Boolean).length || null;
      }
    } else if (displayItem.type === 'document') {
      wordCount = displayItem.item.wordCount ?? null;
      if (wordCount == null) {
        const text = (displayItem.item.textContent || displayItem.item.description || '').replace(
          /<[^>]*>/g,
          ''
        );
        wordCount = text.split(/\s+/).filter(Boolean).length || null;
      }
    } else if (displayItem.type === 'saved') {
      wordCount = displayItem.item.wordCount ?? lazyWordCount;
    }
    if (wordCount == null) return null;
    return Math.max(1, Math.round(wordCount / 200));
  });

  // Strip tags and decode entities to plain text. DOMParser handles numeric
  // entities (e.g. `&#8220;`) that a naive tag-strip would leave visible.
  function htmlToText(html: string): string {
    if (!html) return '';
    // Keep block boundaries from gluing words together (textContent has no
    // separators), then let DOMParser decode entities (incl. numeric like
    // `&#8220;`) that a bare tag-strip would leave visible.
    const spaced = html.replace(
      /<\/?(p|div|h[1-6]|li|ul|ol|blockquote|section|article|header|footer|tr|br)\b[^>]*>/gi,
      '$& '
    );
    try {
      const doc = new DOMParser().parseFromString(spaced, 'text/html');
      return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    } catch {
      return spaced
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // The preview from the item's own metadata (RSS description / summary).
  let metaSummary = $derived.by(() => {
    let raw = '';
    if (displayItem.type === 'article') raw = displayItem.item.summary || '';
    else if (displayItem.type === 'document')
      raw = displayItem.item.description || displayItem.item.textContent || '';
    else if (displayItem.type === 'saved') raw = displayItem.item.description || '';
    return htmlToText(raw);
  });

  // Lazy fallback: some feeds ship items with no description at all, which left
  // the card blank even when the full body exists. Derive a preview from the
  // body (kept out of memory) — preferring the saved copy's stored full text,
  // then the feed body in IndexedDB. Only runs when there's no metadata summary.
  let lazyBodyExcerpt = $state('');
  $effect(() => {
    // Don't clear eagerly here: this effect re-runs whenever `displayItem` gets
    // a fresh object reference (e.g. hovering a saved item marks it read, which
    // re-derives the list). Synchronously blanking the excerpt and then async-
    // reloading it caused a visible flash. Keep the prior value and only swap in
    // the reloaded text once it resolves — for the same item it's identical.
    if (metaSummary || displayItem.type === 'document') {
      lazyBodyExcerpt = '';
      return;
    }

    // Capture identity up-front, while the union is still narrowed.
    let savedRkey: string | undefined;
    let articleRef: { id?: number; guid: string; subscriptionId: number } | undefined;
    if (displayItem.type === 'saved') {
      savedRkey = displayItem.item.rkey;
    } else {
      const a = displayItem.item;
      savedRkey = a.guid ? savesStore.getByGuid(a.guid)?.rkey : undefined;
      articleRef = { id: a.id, guid: a.guid, subscriptionId: a.subscriptionId };
    }

    let cancelled = false;
    (async () => {
      let body = '';
      try {
        // Prefer the saved copy's stored full text.
        if (savedRkey) body = (await savesStore.getContent(savedRkey)) || '';
        // Else the feed body in IndexedDB (in-memory article is "light").
        if (!body && articleRef) {
          let row = articleRef.id != null ? await db.articles.get(articleRef.id) : undefined;
          if (!row && articleRef.guid) {
            row = await db.articles
              .where('guid')
              .equals(articleRef.guid)
              .filter((a) => a.subscriptionId === articleRef!.subscriptionId)
              .first();
          }
          body = row?.content || '';
        }
      } catch {
        // Best effort — leave the excerpt empty.
      }
      if (!cancelled) lazyBodyExcerpt = htmlToText(body);
    })();
    return () => {
      cancelled = true;
    };
  });

  let summaryText = $derived.by(() => {
    const text = metaSummary || lazyBodyExcerpt;
    return text.length > 200 ? text.slice(0, 200) + '...' : text;
  });

  // Type badge
  let typeBadge = $derived.by(() => {
    if (displayItem.type === 'saved') return displayItem.item.domain || 'Saved';
    return '';
  });

  let popoverOpen = $state(false);

  // Swipe-to-open menu on touch devices
  let touchStartX = 0;
  let touchStartY = 0;
  let swipeOffset = $state(0);
  let swipeActive = false;
  let directionLocked = false;
  let isHorizontal = false;
  let snappingBack = $state(false);
  let thresholdTriggered = false;
  const SWIPE_THRESHOLD = 60;

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    swipeActive = true;
    directionLocked = false;
    isHorizontal = false;
    snappingBack = false;
    thresholdTriggered = false;
    swipeOffset = 0;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!swipeActive) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;

    // Lock direction after 10px of movement
    if (!directionLocked && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      directionLocked = true;
      isHorizontal = Math.abs(dx) > Math.abs(dy);
    }

    if (!directionLocked || !isHorizontal) return;

    // Only allow left swipe (negative offset)
    swipeOffset = Math.min(0, dx);

    // Haptic feedback when crossing threshold
    if (!thresholdTriggered && swipeOffset < -SWIPE_THRESHOLD) {
      thresholdTriggered = true;
      navigator.vibrate?.(10);
    }
  }

  function handleTouchEnd() {
    if (!swipeActive) return;
    swipeActive = false;

    if (swipeOffset < -SWIPE_THRESHOLD) {
      // Snap back and open menu
      snappingBack = true;
      swipeOffset = 0;
      setTimeout(() => {
        snappingBack = false;
        popoverOpen = true;
      }, 200);
    } else {
      // Snap back without opening
      snappingBack = true;
      swipeOffset = 0;
      setTimeout(() => {
        snappingBack = false;
      }, 200);
    }
  }

  let tagMenuOpenLocal = $state(false);
  let tagMenuAnchorRef = $state<HTMLElement | null>(null);
  let tagMenuOpen = $derived(tagMenuOpenLocal || feedViewStore.tagMenuItemKey === itemKey);

  let labelItemType = $derived.by((): 'article' | 'document' | 'saved' => displayItem.type);

  // Sharing to your linkblog, keyed on the item's URL — the same path the feed
  // card and reader use. Discussion counts stay a reader-only concern; the saved
  // list keeps just the share toggle, so the row stays quiet.
  let isShared = $derived(Boolean(url) && linkblogStore.isShared(url));
  let canShare = $derived(Boolean(auth.user) && Boolean(url) && !preferences.linkblogDisabled);

  // The article record to share, built from whichever item type this card shows.
  // A document carries its recordUri as repostUri so a reshare credits the original.
  function buildShareTarget(): { article: Article; repostUri?: string } | null {
    if (!url) return null;
    if (displayItem.type === 'article') return { article: displayItem.item };
    if (displayItem.type === 'saved') {
      const s = displayItem.item;
      return {
        article: {
          subscriptionId: 0,
          guid: s.url,
          url: s.url,
          title: s.title ?? s.url,
          author: s.author ?? undefined,
          summary: s.description ?? undefined,
          imageUrl: s.image ?? undefined,
          publishedAt: s.publishedAt ?? s.savedAt,
          fetchedAt: Date.now(),
        },
      };
    }
    const d = displayItem.item;
    const image = d.coverImageCid
      ? `https://cdn.bsky.app/img/feed_fullsize/plain/${d.authorDid}/${d.coverImageCid}@jpeg`
      : undefined;
    return {
      article: {
        subscriptionId: 0,
        guid: url,
        url,
        title: d.title || url,
        summary: d.description ?? undefined,
        imageUrl: image,
        publishedAt: d.publishedAt,
        fetchedAt: Date.now(),
      },
      repostUri: d.recordUri,
    };
  }

  let hasShareDraft = $derived(Boolean(url) && shareDraftsStore.hasDraft(url));

  // Sharing from the saved list opens the composer drawer (drafting, quotes,
  // the works — instant is one Post away). Removal stays here as the toggle's
  // shared-state action.
  function toggleShare() {
    if (isShared) {
      void linkblogStore.unshare(url);
      return;
    }
    const t = buildShareTarget();
    if (!t) return;
    shareComposerStore.open({
      article: t.article,
      repostUri: t.repostUri,
      itemKey,
      mode: 'create',
    });
  }

  let popoverMenuItems = $derived.by(() => {
    const items: {
      label: string;
      icon?: string;
      variant?: 'default' | 'danger';
      active?: boolean;
      onclick: () => void;
    }[] = [
      {
        label: isArchived ? 'Move to inbox' : 'Archive',
        icon: isArchived ? 'inbox' : 'archive',
        onclick: () => {
          onArchive?.();
        },
      },
      {
        label: 'Tag',
        icon: 'tag',
        onclick: () => {
          tagMenuOpenLocal = true;
        },
      },
    ];
    if (canShare) {
      items.push({
        label: isShared
          ? 'Remove from linkblog'
          : hasShareDraft
            ? 'Resume share draft'
            : 'Share to your linkblog',
        icon: 'share',
        active: isShared,
        onclick: () => {
          void toggleShare();
        },
      });
    }
    if (onSaveToSemble) {
      items.push({
        label: 'Save to Semble',
        icon: 'semble',
        onclick: () => onSaveToSemble!(),
      });
    }
    if (onSaveToMargin) {
      items.push({
        label: 'Save to Margin',
        icon: 'margin',
        onclick: () => onSaveToMargin!(),
      });
    }
    if (onRemove) {
      items.push({
        label: 'Delete',
        icon: 'trash',
        variant: 'danger',
        onclick: () => {
          onRemove();
        },
      });
    }
    return items;
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<article
  class="bookmark-card"
  class:selected
  class:menu-open={popoverOpen}
  role="button"
  tabindex="0"
  onmouseenter={() => onHover?.()}
  onkeydown={(e) => {
    if (e.key === 'Enter') onOpen?.();
  }}
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="swipe-track"
    class:snapping={snappingBack}
    style="transform: translateX({swipeOffset}px)"
  >
    <div class="bookmark-inner">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="bookmark-content"
        onclick={() => {
          if (popoverOpen) {
            popoverOpen = false;
            return;
          }
          onOpen?.();
        }}
      >
        <h3 class="bookmark-title">{title}</h3>
        {#if summaryText}
          <p class="bookmark-summary">{summaryText}</p>
        {/if}
        <div class="bookmark-meta">
          <span class="meta-icon">
            {#if faviconUrl}
              <img src={faviconUrl} alt="" class="favicon" />
            {:else}
              <Icon name={itemType === 'document' ? 'standard-site' : 'rss'} size={14} />
            {/if}
          </span>
          {#if typeBadge}
            <span class="meta-type-badge">{typeBadge}</span>
          {:else if feedTitle}
            <span class="meta-feed">{feedTitle}</span>
          {/if}
          {#if displayItem.type === 'article' && displayItem.item.author}
            <span class="meta-author">{displayItem.item.author}</span>
          {/if}
          {#if readTimeMinutes}
            <span class="meta-read-time">
              <Icon name="clock" size={12} />
              {readTimeMinutes} min
            </span>
          {/if}
          <span class="meta-date">{formatRelativeDate(publishedAt)}</span>
          {#each tags as tag, i}
            {#if i === 0}<span class="meta-dot" aria-hidden="true">·</span>{/if}
            <span class="tag-chip">{tag}</span>
          {/each}
        </div>
      </div>

      <div class="card-actions" bind:this={tagMenuAnchorRef}>
        <PopoverMenu items={popoverMenuItems} bind:open={popoverOpen} />
      </div>
    </div>
    <div class="swipe-reveal">
      <Icon name="more-horizontal" size={16} />
      <span>Actions</span>
    </div>
  </div>

  {#if tagMenuOpen}
    <TagMenu
      {itemKey}
      itemType={labelItemType}
      anchorEl={tagMenuAnchorRef}
      onClose={() => {
        tagMenuOpenLocal = false;
        feedViewStore.closeTagMenu();
      }}
    />
  {/if}
</article>

<style>
  .bookmark-card {
    position: relative;
    cursor: pointer;
    border-radius: 8px;
    overflow: hidden;
    transition: background-color 0.15s;
  }

  .swipe-track {
    display: flex;
    width: fit-content;
    min-width: 100%;
  }

  .swipe-track.snapping {
    transition: transform 0.2s ease-out;
  }

  .bookmark-inner {
    position: relative;
    padding: 0.75rem 1rem;
    flex: 0 0 100%;
    min-width: 0;
  }

  .swipe-reveal {
    flex-shrink: 0;
    display: none;
    align-items: center;
    gap: 0.375rem;
    padding: 0 1rem;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .swipe-reveal {
      display: flex;
    }
  }

  .bookmark-card.menu-open {
    z-index: 10;
    overflow: visible;
  }

  .bookmark-card.selected {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .meta-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .meta-icon::before {
    content: none;
    margin-right: 0;
  }

  .favicon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
  }

  .bookmark-content {
    flex: 1;
    min-width: 0;
  }

  .bookmark-title {
    font-size: var(--text-lg);
    font-weight: var(--weight-medium);
    color: var(--color-text);
    margin: 0;
    padding-right: 2rem;
    line-height: var(--leading-snug);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .bookmark-summary {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0.25rem 0 0;
    line-height: var(--leading-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .bookmark-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.375rem;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .bookmark-meta > :not(:first-child)::before {
    content: '·';
    margin-right: 0.375rem;
    opacity: 0.5;
  }

  .bookmark-meta > .meta-icon + :not(:first-child)::before {
    content: none;
    margin-right: 0;
  }

  .meta-feed {
    font-weight: var(--weight-medium);
  }

  .meta-type-badge {
    font-weight: var(--weight-medium);
    color: var(--color-primary, #2563eb);
  }

  .meta-read-time {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.375rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-medium);
    background: rgba(37, 99, 235, 0.08);
    color: var(--color-primary, #2563eb);
    border-radius: 999px;
  }

  .bookmark-meta > .meta-dot,
  .bookmark-meta > .tag-chip {
    margin-right: 0;
  }

  .bookmark-meta > .meta-dot::before,
  .bookmark-meta > .tag-chip::before {
    content: none;
    margin-right: 0;
  }

  .meta-dot {
    opacity: 0.5;
  }

  .card-actions {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  @media (prefers-color-scheme: dark) {
    .bookmark-card:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
