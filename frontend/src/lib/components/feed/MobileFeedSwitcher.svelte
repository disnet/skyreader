<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { getSourceDisplay } from '$lib/utils/sourceDisplay';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { unreadCounts } from '$lib/stores/unreadCounts.svelte';
  import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
  import { feedViewStore } from '$lib/stores/feedView.svelte';
  import {
    channelSuggestions,
    type ChannelSuggestion,
  } from '$lib/stores/channelSuggestions.svelte';
  import {
    savedChannelSuggestions,
    type SavedChannelSuggestion,
  } from '$lib/stores/savedChannelSuggestions.svelte';
  import { channelPath, feedPath, categoryPath, FEEDS_PATH, SAVED_PATH } from '$lib/utils/viewNav';
  import Icon from '$lib/components/Icon.svelte';
  import Tooltip from '$lib/components/Tooltip.svelte';
  import type { Subscription } from '$lib/types';

  interface Props {
    onclose: () => void;
    currentTitle: string;
    onEditChannel?: (id: number) => void;
    onCreateChannel?: (type?: 'feed' | 'saved') => void;
  }

  let { onclose, currentTitle, onEditChannel, onCreateChannel }: Props = $props();

  let searchQuery = $state('');

  const SOURCES_EXPANDED_KEY = 'skyreader-mobile-switcher-sources-expanded';

  let sourcesExpanded = $state(
    (() => {
      if (typeof localStorage === 'undefined') return false;
      return localStorage.getItem(SOURCES_EXPANDED_KEY) === '1';
    })()
  );

  function toggleSources() {
    sourcesExpanded = !sourcesExpanded;
    try {
      localStorage.setItem(SOURCES_EXPANDED_KEY, sourcesExpanded ? '1' : '0');
    } catch {
      // ignore storage failures (private mode, quota)
    }
  }

  // Render/compute the Sources tree only when the section is open or the user is
  // searching. With a large subscription list, building and rendering every feed
  // row on open is the expensive part, so keep it lazy.
  let showSources = $derived(sourcesExpanded || searchQuery.trim().length > 0);

  // Derive data from stores
  let subscriptions = $derived(subscriptionsStore.subscriptions);
  let feedUnreadCounts = $derived(unreadCounts.feedCounts);
  let totalUnread = $derived(unreadCounts.totalArticles);
  let savedCount = $derived(itemLabelsStore.savedCount);

  type IconName =
    | 'home'
    | 'inbox'
    | 'bookmark'
    | 'share'
    | 'bell'
    | 'settings'
    | 'filter'
    | 'plus'
    | 'newspaper'
    | 'rss'
    | 'file-text'
    | 'folder'
    | 'users'
    | 'highlighter';

  type NavItem =
    | {
        type: 'view';
        id: string;
        label: string;
        count?: number;
        icon: IconName;
        indent?: boolean;
      }
    | {
        type: 'category';
        id: string;
        label: string;
        count: number;
        icon: IconName;
        indent?: boolean;
      }
    | {
        type: 'feed';
        id: number;
        label: string;
        count: number;
        iconUrl: string | null;
        sourceIcon: string;
        sourceLabel: string;
        sourceClass: string;
        indent?: boolean;
      }
    | {
        type: 'utility';
        id: string;
        label: string;
        count?: number;
        icon: IconName;
        indent?: boolean;
      }
    | {
        type: 'filteredView';
        id: string;
        label: string;
        count?: number;
        icon: IconName;
        indent?: boolean;
      };

  type SectionData = {
    section: string;
    groupId?: 'home' | 'everything' | 'saved' | 'other' | 'sources';
    items: NavItem[];
  };

  function sourceSortRank(sub: Subscription): number {
    if (!sub.sourceType || sub.sourceType === 'rss') return 0;
    if (sub.sourceType === 'atproto.documents' && sub.feedUrl?.startsWith('at://')) return 2;
    if (sub.sourceType === 'atproto.documents') return 3;
    return 4;
  }

  function sortSources(sources: Subscription[]) {
    return [...sources].sort((a, b) => {
      const rankDiff = sourceSortRank(a) - sourceSortRank(b);
      if (rankDiff !== 0) return rankDiff;
      return (a.customTitle || a.title || '').localeCompare(
        b.customTitle || b.title || '',
        undefined,
        {
          sensitivity: 'base',
        }
      );
    });
  }

  function sourceToNavItem(s: Subscription, indent = false): NavItem {
    const sourceDisplay = getSourceDisplay(s.sourceType, s.feedUrl, s.siteUrl);
    return {
      type: 'feed',
      id: s.id!,
      label: s.customTitle || s.title,
      count: feedUnreadCounts.get(s.id!) || 0,
      iconUrl:
        s.customIconUrl ||
        (s.sourceType?.startsWith('atproto.')
          ? s.siteUrl
            ? getFaviconUrl(s.siteUrl)
            : '/icons/icon-192.svg'
          : getFaviconUrl(s.siteUrl || s.feedUrl || '')),
      sourceIcon: sourceDisplay.iconName,
      sourceLabel: sourceDisplay.label,
      sourceClass: sourceDisplay.pillClass,
      indent,
    };
  }

  let filteredItems = $derived.by((): SectionData[] => {
    const query = searchQuery.toLowerCase().trim();

    const homeItem: NavItem = {
      type: 'view',
      id: 'home',
      label: 'Home',
      icon: 'home',
    };
    const everythingItem: NavItem = {
      type: 'view',
      id: 'all',
      label: 'Feeds',
      count: totalUnread,
      icon: 'inbox',
    };
    const savedItem: NavItem = {
      type: 'view',
      id: 'saved',
      label: 'Saved',
      count: savedCount,
      icon: 'bookmark',
    };
    const otherItems: NavItem[] = [
      {
        type: 'utility',
        id: 'linkblog',
        label: 'Linkblog',
        icon: 'share' as IconName,
      },
      {
        type: 'utility',
        id: 'highlights',
        label: 'Highlights',
        icon: 'highlighter' as IconName,
      },
      {
        type: 'utility',
        id: 'discover',
        label: 'Discover',
        icon: 'users' as IconName,
      },
      {
        type: 'utility',
        id: 'sources',
        label: 'Manage Sources',
        icon: 'rss' as IconName,
      },
      {
        type: 'utility',
        id: 'settings',
        label: 'Settings',
        icon: 'settings' as IconName,
      },
    ];

    const sourceChannelItems: NavItem[] = filteredViewsStore.views
      .filter((v) => v.mode !== 'saved')
      .map((v) => ({
        type: 'filteredView' as const,
        id: v.uuid,
        label: v.name,
        count: v.id != null ? (unreadCounts.channelCounts.get(v.id) ?? 0) : 0,
        icon: 'newspaper' as const,
        indent: true,
      }));

    const savedChannelItems: NavItem[] = filteredViewsStore.views
      .filter((v) => v.mode === 'saved')
      .map((v) => ({
        type: 'filteredView' as const,
        id: v.uuid,
        label: v.name,
        count: v.id != null ? (unreadCounts.channelCounts.get(v.id) ?? 0) : 0,
        icon: 'bookmark' as const,
        indent: true,
      }));

    const filterItem = (item: NavItem) => {
      if (!query) return true;
      return item.label.toLowerCase().includes(query);
    };

    // Only build the (potentially large) Sources tree when the section is open
    // or the user is searching — otherwise skip the grouping/sorting/mapping work.
    const feedItems: NavItem[] = [];
    if (showSources) {
      const byCategory = new Map<string, Subscription[]>();
      const uncategorized: Subscription[] = [];
      for (const sub of subscriptions) {
        if (sub.category) {
          const existing = byCategory.get(sub.category) || [];
          existing.push(sub);
          byCategory.set(sub.category, existing);
        } else {
          uncategorized.push(sub);
        }
      }

      for (const [name, subs] of [...byCategory.entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
      )) {
        const sortedSubs = sortSources(subs);
        const childItems = sortedSubs.map((s) => sourceToNavItem(s, true));
        const categoryItem: NavItem = {
          type: 'category',
          id: name,
          label: name,
          count: sortedSubs.reduce(
            (sum, s) => sum + (s.id ? (feedUnreadCounts.get(s.id) ?? 0) : 0),
            0
          ),
          icon: 'folder',
        };

        if (!query || filterItem(categoryItem)) {
          feedItems.push(categoryItem, ...childItems);
        } else {
          const matchingChildren = childItems.filter(filterItem);
          if (matchingChildren.length > 0) {
            feedItems.push(categoryItem, ...matchingChildren);
          }
        }
      }
      const uncategorizedItems = sortSources(uncategorized).map((s) => sourceToNavItem(s));
      feedItems.push(...(query ? uncategorizedItems.filter(filterItem) : uncategorizedItems));
    }

    const sections: SectionData[] = [];

    // Home: the default landing surface (a route, not a feed filter)
    if (filterItem(homeItem)) {
      sections.push({ section: '', groupId: 'home', items: [homeItem] });
    }

    // Everything group: Everything + source channels (+ suggestions rendered inline in template)
    const everythingGroup = [everythingItem, ...sourceChannelItems].filter(filterItem);
    if (everythingGroup.length > 0 || (!query && channelSuggestions.suggestions.length > 0)) {
      sections.push({
        section: '',
        groupId: 'everything',
        items: everythingGroup,
      });
    }

    // Saved group: Saved + saved channels (+ suggestions rendered inline in template)
    const savedGroup = [savedItem, ...savedChannelItems].filter(filterItem);
    if (savedGroup.length > 0 || (!query && savedChannelSuggestions.suggestions.length > 0)) {
      sections.push({ section: '', groupId: 'saved', items: savedGroup });
    }

    // Other utility items
    const filteredOther = otherItems.filter(filterItem);
    if (filteredOther.length > 0) {
      sections.push({ section: '', groupId: 'other', items: filteredOther });
    }

    // Always surface the Sources header (as a disclosure toggle) when there are
    // subscriptions, even while collapsed and empty. When searching, only show it
    // if there are matches.
    if ((showSources && feedItems.length > 0) || (!query && subscriptions.length > 0)) {
      sections.push({
        section: 'Sources',
        groupId: 'sources',
        items: feedItems,
      });
    }

    return sections;
  });

  // Get current filter from URL
  let currentFilter = $derived.by(() => {
    const url = $page.url;
    if (url.pathname === '/home') return { type: 'home' };
    const onFeeds = url.pathname === FEEDS_PATH;
    const onSaved = url.pathname === SAVED_PATH;
    const view = url.searchParams.get('view');
    if (view && (onFeeds || onSaved)) return { type: 'filteredView', id: view };
    if (onSaved) return { type: 'saved' };
    if (!onFeeds) return { type: 'none' };
    const feed = url.searchParams.get('feed');
    const category = url.searchParams.get('category');
    if (feed) return { type: 'feed', id: parseInt(feed) };
    if (category) return { type: 'category', name: category };
    return { type: 'all' };
  });

  function isItemActive(item: NavItem): boolean {
    const filter = currentFilter;
    if (item.type === 'view') {
      if (item.id === 'home' && filter.type === 'home') return true;
      if (item.id === 'all' && filter.type === 'all') return true;
      if (item.id === 'saved' && filter.type === 'saved') return true;
    }
    if (item.type === 'feed' && filter.type === 'feed' && filter.id === item.id) return true;
    if (item.type === 'category' && filter.type === 'category' && filter.name === item.id)
      return true;
    if (item.type === 'filteredView' && filter.type === 'filteredView' && filter.id === item.id)
      return true;
    return false;
  }

  async function acceptSuggestion(suggestion: ChannelSuggestion) {
    const id = await filteredViewsStore.create({
      name: suggestion.name,
      sourceMode: suggestion.sourceMode,
      sourceKeys: suggestion.sourceKeys,
      typeFilter: suggestion.typeFilter.length > 0 ? suggestion.typeFilter : undefined,
      autoRule: suggestion.autoRule,
      readFilter: 'unread',
      sortOrder: 'newest',
    });
    goto(channelPath(id));
    onclose();
  }

  async function acceptSavedSuggestion(suggestion: SavedChannelSuggestion) {
    const id = await filteredViewsStore.create({
      name: suggestion.name,
      mode: 'saved',
      savedSourceFilter: suggestion.savedSourceFilter,
      savedDomainFilter: suggestion.savedDomainFilter,
      savedReadingLength: suggestion.savedReadingLength,
      savedDateFilter: suggestion.savedDateFilter,
      readFilter: suggestion.readFilter ?? 'unread',
      sortOrder: suggestion.sortOrder ?? 'newest',
    });
    goto(channelPath(id));
    onclose();
  }

  function selectItem(item: NavItem) {
    let url = FEEDS_PATH;
    if (item.type === 'view') {
      if (item.id === 'home') url = '/home';
      else if (item.id === 'saved') url = SAVED_PATH;
    } else if (item.type === 'feed') {
      url = feedPath(item.id);
    } else if (item.type === 'category') {
      url = categoryPath(item.id);
    } else if (item.type === 'filteredView') {
      url = channelPath(item.id);
    } else if (item.type === 'utility') {
      url = `/${item.id}`;
    }
    goto(url);
    onclose();
  }
</script>

<div class="feed-switcher">
  <div class="search-container">
    <Icon name="search" size={16} />
    <input
      type="text"
      class="search-input"
      placeholder="Search feeds..."
      aria-label="Search feeds"
      bind:value={searchQuery}
    />
  </div>

  <div class="items-list">
    {#each filteredItems as { section, groupId, items }}
      <div class="nav-group" class:tinted={groupId === 'everything' || groupId === 'saved'}>
        {#if section && groupId === 'sources' && !searchQuery}
          <button
            class="section-header section-toggle"
            onclick={toggleSources}
            aria-expanded={sourcesExpanded}
          >
            <span>{section}</span>
            <span class="section-chevron" class:expanded={sourcesExpanded}>
              <Icon name="chevron-right" size={14} />
            </span>
          </button>
        {:else if section}
          <div class="section-header">
            <span>{section}</span>
          </div>
        {/if}
        {#each items as item}
          {#if item.type === 'view' && (item.id === 'all' || item.id === 'saved') && onCreateChannel}
            <div class="nav-item-row" class:active={isItemActive(item)}>
              <button class="nav-item-main" onclick={() => selectItem(item)}>
                <span class="item-icon"><Icon name={item.icon} size={18} /></span>
                <span class="item-label">{item.label}</span>
              </button>
              <button
                class="channel-add-btn"
                onclick={(e) => {
                  e.stopPropagation();
                  onCreateChannel(item.id === 'saved' ? 'saved' : 'feed');
                }}
                aria-label="New channel"
              >
                <Icon name="plus" size={16} />
              </button>
              {#if item.count && item.count > 0}
                <span class="item-count row-count">{item.count}</span>
              {/if}
            </div>
          {:else if item.type === 'filteredView' && onEditChannel}
            <div class="nav-item-row" class:active={isItemActive(item)}>
              <button class="nav-item-main" onclick={() => selectItem(item)}>
                <span class="item-icon"><Icon name={item.icon} size={18} /></span>
                <span class="item-label">{item.label}</span>
              </button>
              <button
                class="channel-edit-btn"
                onclick={() => {
                  const view = filteredViewsStore.getByUuid(item.id);
                  if (view?.id != null) onEditChannel(view.id);
                }}
                aria-label="Edit channel"
              >
                <Icon name="edit" size={14} />
              </button>
              {#if item.count && item.count > 0}
                <span class="item-count row-count">{item.count}</span>
              {/if}
            </div>
          {:else}
            <button
              class="nav-item"
              class:active={isItemActive(item)}
              class:indent={item.indent}
              class:category-item={item.type === 'category'}
              onclick={() => selectItem(item)}
            >
              {#if item.type === 'view' || item.type === 'utility' || item.type === 'filteredView' || item.type === 'category'}
                <span class="item-icon"><Icon name={item.icon} size={18} /></span>
              {:else if item.type === 'feed'}
                {#if item.iconUrl}
                  <img src={item.iconUrl} alt="" class="feed-icon" />
                {:else}
                  <span class="feed-icon-placeholder"></span>
                {/if}
              {/if}
              <span class="item-label">{item.label}</span>
              {#if item.count && item.count > 0}
                <span class="item-count">{item.count}</span>
              {/if}
              {#if item.type === 'feed'}
                <span
                  class="source-type-icon {item.sourceClass}"
                  title={item.sourceLabel}
                  aria-label={item.sourceLabel}
                >
                  <Icon name={item.sourceIcon as any} size={13} strokeWidth={2} />
                </span>
              {/if}
            </button>
          {/if}
        {/each}
        {#if groupId === 'everything' && !searchQuery}
          {#each channelSuggestions.suggestions as suggestion (suggestion.id)}
            <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
            <div class="nav-item suggestion-accept" onclick={() => acceptSuggestion(suggestion)}>
              <span class="item-icon suggestion-icon"><Icon name="plus" size={16} /></span>
              <span class="item-label">{suggestion.name}</span>
              <span class="suggestion-actions" onclick={(e) => e.stopPropagation()}>
                <Tooltip text={suggestion.description} />
                <button
                  class="suggestion-dismiss"
                  onclick={(e) => {
                    e.stopPropagation();
                    channelSuggestions.dismiss(suggestion.id);
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </span>
            </div>
          {/each}
          <a
            href="/channels/discover"
            class="nav-item more-suggestions-link"
            onclick={() => onclose()}
          >
            <span class="item-icon"><Icon name="arrow-right" size={16} /></span>
            <span class="item-label">More channel ideas</span>
          </a>
        {/if}
        {#if groupId === 'saved' && !searchQuery}
          {#each savedChannelSuggestions.suggestions as suggestion (suggestion.id)}
            <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
            <div
              class="nav-item suggestion-accept"
              onclick={() => acceptSavedSuggestion(suggestion)}
            >
              <span class="item-icon suggestion-icon"><Icon name="plus" size={16} /></span>
              <span class="item-label">{suggestion.name}</span>
              <span class="suggestion-actions" onclick={(e) => e.stopPropagation()}>
                <Tooltip text={suggestion.description} />
                <button
                  class="suggestion-dismiss"
                  onclick={(e) => {
                    e.stopPropagation();
                    savedChannelSuggestions.dismiss(suggestion.id);
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </span>
            </div>
          {/each}
          <a
            href="/channels/discover"
            class="nav-item more-suggestions-link"
            onclick={() => onclose()}
          >
            <span class="item-icon"><Icon name="arrow-right" size={16} /></span>
            <span class="item-label">More channel ideas</span>
          </a>
        {/if}
      </div>
    {/each}
    {#if filteredItems.length === 0 || filteredItems.every((s) => s.items.length === 0)}
      <div class="no-results">No matches found</div>
    {/if}
  </div>
</div>

<style>
  .feed-switcher {
    display: flex;
    flex-direction: column;
    padding: 0 0.5rem 0.5rem;
  }

  .search-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    margin: 0 0.5rem 0.5rem;
    background: var(--color-bg-secondary, #f5f5f5);
    border-radius: 8px;
    color: var(--color-text-secondary);
  }

  .search-input {
    flex: 1;
    border: none;
    background: none;
    color: var(--color-text);
    font-size: var(--text-base);
    outline: none;
  }

  .search-input::placeholder {
    color: var(--color-text-secondary);
  }

  .items-list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem 0.375rem;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
  }

  .section-toggle {
    width: calc(100% - 1rem);
    margin: 0 0.5rem;
    background: none;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font: inherit;
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
  }

  .section-toggle:active {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .section-chevron {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
    transition: transform 0.15s;
  }

  .section-chevron.expanded {
    transform: rotate(90deg);
  }

  @media (prefers-color-scheme: dark) {
    .section-toggle:active {
      background: rgba(255, 255, 255, 0.1);
    }
  }

  .channel-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    margin-right: 0.5rem;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
  }

  .channel-add-btn:active {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    background: none;
    border: none;
    border-radius: 8px;
    margin: 0 0.5rem;
    color: var(--color-text);
    font-size: var(--text-lg);
    text-align: left;
    width: calc(100% - 1rem);
    transition: background 0.15s;
  }

  .nav-item:active {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .nav-item.active {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
    font-weight: var(--weight-medium);
  }

  .nav-item.indent {
    padding-left: 2.25rem;
  }

  .nav-item.category-item {
    color: var(--color-text-secondary);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
  }

  .nav-item.category-item.active {
    color: var(--color-primary);
  }

  .nav-group {
    display: flex;
    flex-direction: column;
  }

  .nav-group.tinted {
    background: rgba(0, 0, 0, 0.025);
    border-radius: 12px;
    margin: 0 0.5rem 0.5rem;
    padding: 0.25rem 0;
  }

  .nav-group.tinted .nav-item,
  .nav-group.tinted .nav-item-row {
    margin-left: 0;
    margin-right: 0;
    width: calc(100% - 0rem);
  }

  @media (prefers-color-scheme: dark) {
    .nav-group.tinted {
      background: rgba(255, 255, 255, 0.025);
    }
  }

  .row-count {
    margin-right: 1rem;
  }

  .nav-item-row.active .row-count {
    color: var(--color-primary);
  }

  .nav-item-row {
    display: flex;
    align-items: center;
    margin: 0 0.5rem;
    border-radius: 8px;
    transition: background 0.15s;
  }

  .nav-item-row.active {
    background: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
    font-weight: var(--weight-medium);
  }

  .nav-item-row.active .item-icon {
    color: var(--color-primary);
  }

  .nav-item-main {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
    padding: 0.625rem 0 0.625rem 1rem;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    font-size: var(--text-lg);
    text-align: left;
  }

  .nav-item-main:active {
    opacity: 0.7;
  }

  .item-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--color-text-secondary);
  }

  .nav-item.active .item-icon {
    color: var(--color-primary);
  }

  .feed-icon {
    width: 18px;
    height: 18px;
    border-radius: 3px;
    flex-shrink: 0;
    object-fit: cover;
  }

  .feed-icon-placeholder {
    width: 18px;
    height: 18px;
    border-radius: 3px;
    background: var(--color-bg-secondary);
    flex-shrink: 0;
  }

  .item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-count {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, #f5f5f5);
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .source-type-icon {
    flex-shrink: 0;
    width: 1.125rem;
    height: 1.125rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    color: color-mix(in srgb, var(--source-accent) 72%, var(--color-text-secondary));
    background: color-mix(in srgb, var(--source-accent) 7%, transparent);
    border: 1px solid color-mix(in srgb, var(--source-accent) 12%, transparent);
  }

  .source-type-icon.pill-rss {
    --source-accent: #9a6a3a;
  }

  .source-type-icon.pill-shares {
    --source-accent: #4f7f61;
  }

  .source-type-icon.pill-documents {
    --source-accent: #74609a;
  }

  .source-type-icon.pill-publication {
    --source-accent: #9a694b;
  }

  .source-type-icon.pill-linkblog {
    --source-accent: var(--color-primary);
  }

  .source-type-icon.pill-collection {
    --source-accent: #557f89;
  }

  .suggestion-accept {
    color: var(--color-text-secondary);
  }

  .suggestion-icon {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1.5px dashed currentColor;
  }

  .suggestion-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .suggestion-dismiss {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    border-radius: 6px;
    flex-shrink: 0;
    padding: 0;
  }

  .suggestion-dismiss:active {
    background: var(--color-bg-secondary);
  }

  .more-suggestions-link {
    text-decoration: none;
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .channel-edit-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    padding: 0;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .channel-edit-btn:active {
    background: var(--color-bg-secondary, #f5f5f5);
  }

  .no-results {
    padding: 1.5rem;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: var(--text-md);
  }

  @media (prefers-color-scheme: dark) {
    .search-container {
      background: var(--color-bg-secondary, #2a2a2a);
    }

    .nav-item:active {
      background: rgba(255, 255, 255, 0.1);
    }

    .item-count {
      background: rgba(255, 255, 255, 0.1);
    }

    .section-add-btn:active,
    .channel-edit-btn:active {
      background: rgba(255, 255, 255, 0.1);
    }
  }
</style>
