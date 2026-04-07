<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { getFaviconUrl } from '$lib/utils/favicon';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { activityStore } from '$lib/stores/activity.svelte';
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
  import Icon from '$lib/components/Icon.svelte';
  import Tooltip from '$lib/components/Tooltip.svelte';

  interface Props {
    onclose: () => void;
    currentTitle: string;
    onEditChannel?: (id: number) => void;
    onCreateChannel?: () => void;
  }

  let { onclose, currentTitle, onEditChannel, onCreateChannel }: Props = $props();

  let searchQuery = $state('');

  // Derive data from stores
  let subscriptions = $derived(subscriptionsStore.subscriptions);
  let feedUnreadCounts = $derived(unreadCounts.feedCounts);
  let totalUnread = $derived(unreadCounts.totalArticles);
  let savedCount = $derived(itemLabelsStore.savedCount);
  let sharedCount = $derived(sharesStore.userShares.size);
  let activityCount = $derived(activityStore.totalReshareCount);

  type IconName =
    | 'inbox'
    | 'bookmark'
    | 'share'
    | 'bell'
    | 'settings'
    | 'filter'
    | 'plus'
    | 'newspaper';

  type NavItem =
    | { type: 'view'; id: string; label: string; count?: number; icon: IconName }
    | { type: 'feed'; id: number; label: string; count: number; iconUrl: string | null }
    | { type: 'utility'; id: string; label: string; count?: number; icon: IconName }
    | { type: 'filteredView'; id: string; label: string; count?: number; icon: IconName };

  type SectionData = {
    section: string;
    items: NavItem[];
  };

  let filteredItems = $derived.by((): SectionData[] => {
    const query = searchQuery.toLowerCase().trim();

    const views: NavItem[] = [
      { type: 'view', id: 'all', label: 'Everything', count: totalUnread, icon: 'inbox' },
      { type: 'view', id: 'saved', label: 'Saved', count: savedCount, icon: 'bookmark' },
      { type: 'view', id: 'shared', label: 'Shared', count: sharedCount, icon: 'share' },
      { type: 'utility', id: 'activity', label: 'Activity', count: activityCount, icon: 'bell' },
      { type: 'utility', id: 'sources', label: 'Manage Sources', icon: 'rss' as IconName },
      { type: 'utility', id: 'settings', label: 'Settings', icon: 'settings' as IconName },
    ];

    const channels: NavItem[] = filteredViewsStore.views.map((v) => ({
      type: 'filteredView' as const,
      id: v.uuid,
      label: v.name,
      count: v.id != null ? (unreadCounts.channelCounts.get(v.id) ?? 0) : 0,
      icon: 'newspaper' as const,
    }));

    const feedItems: NavItem[] = subscriptions.map((s) => ({
      type: 'feed' as const,
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
    }));

    const filterItem = (item: NavItem) => {
      if (!query) return true;
      return item.label.toLowerCase().includes(query);
    };

    const sections: SectionData[] = [];

    const filteredViews = views.filter(filterItem);
    if (filteredViews.length > 0) {
      sections.push({ section: '', items: filteredViews });
    }

    const filteredChannels = channels.filter(filterItem);
    if (
      filteredChannels.length > 0 ||
      channelSuggestions.suggestions.length > 0 ||
      savedChannelSuggestions.suggestions.length > 0
    ) {
      sections.push({ section: 'Channels', items: filteredChannels });
    }

    const filteredFeeds = feedItems.filter(filterItem);
    if (filteredFeeds.length > 0) {
      sections.push({ section: 'Sources', items: filteredFeeds });
    }

    return sections;
  });

  // Get current filter from URL
  let currentFilter = $derived.by(() => {
    const url = $page.url;
    const feed = url.searchParams.get('feed');
    const saved = url.searchParams.get('saved');
    const shared = url.searchParams.get('shared');
    const view = url.searchParams.get('view');
    if (view) return { type: 'filteredView', id: view };
    if (feed) return { type: 'feed', id: parseInt(feed) };
    if (saved) return { type: 'saved' };
    if (shared) return { type: 'shared' };
    return { type: 'all' };
  });

  function isItemActive(item: NavItem): boolean {
    const filter = currentFilter;
    if (item.type === 'view') {
      if (item.id === 'all' && filter.type === 'all') return true;
      if (item.id === 'saved' && filter.type === 'saved') return true;
      if (item.id === 'shared' && filter.type === 'shared') return true;
    }
    if (item.type === 'feed' && filter.type === 'feed' && filter.id === item.id) return true;
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
    goto(`/?view=${id}`);
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
      readFilter: suggestion.readFilter ?? 'all',
      sortOrder: suggestion.sortOrder ?? 'newest',
    });
    goto(`/?view=${id}`);
    onclose();
  }

  function selectItem(item: NavItem) {
    let url = '/';
    if (item.type === 'view') {
      if (item.id === 'saved') url = '/?saved=true';
      else if (item.id === 'shared') url = '/?shared=true';
    } else if (item.type === 'feed') {
      url = `/?feed=${item.id}`;
    } else if (item.type === 'filteredView') {
      url = `/?view=${item.id}`;
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
    {#each filteredItems as { section, items }}
      {#if section}
        <div class="section-header">
          <span>{section}</span>
          {#if section === 'Channels' && onCreateChannel}
            <button
              class="section-add-btn"
              onclick={(e) => {
                e.stopPropagation();
                onCreateChannel();
              }}
              aria-label="New channel"
            >
              <Icon name="plus" size={14} />
            </button>
          {/if}
        </div>
      {/if}
      {#each items as item}
        {#if item.type === 'filteredView' && onEditChannel}
          <div
            class="nav-item-row"
            class:active={isItemActive(item)}
            class:section-child={!!section}
          >
            <button class="nav-item-main" onclick={() => selectItem(item)}>
              <span class="item-icon"><Icon name={item.icon} size={18} /></span>
              <span class="item-label">{item.label}</span>
              {#if item.count && item.count > 0}
                <span class="item-count">{item.count}</span>
              {/if}
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
          </div>
        {:else}
          <button
            class="nav-item"
            class:active={isItemActive(item)}
            class:section-child={!!section}
            onclick={() => selectItem(item)}
          >
            {#if item.type === 'view' || item.type === 'utility' || item.type === 'filteredView'}
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
          </button>
        {/if}
      {/each}
      {#if section === 'Channels' && (channelSuggestions.suggestions.length > 0 || savedChannelSuggestions.suggestions.length > 0) && !searchQuery}
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
        {#each savedChannelSuggestions.suggestions as suggestion (suggestion.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
          <div class="nav-item suggestion-accept" onclick={() => acceptSavedSuggestion(suggestion)}>
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
        {#if channelSuggestions.hasMore || channelSuggestions.suggestions.length > 0 || savedChannelSuggestions.hasMore || savedChannelSuggestions.suggestions.length > 0}
          <a
            href="/channels/discover"
            class="nav-item more-suggestions-link"
            onclick={() => onclose()}
          >
            <span class="item-icon"><Icon name="arrow-right" size={16} /></span>
            <span class="item-label">More channel ideas</span>
          </a>
        {/if}
      {/if}
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
    font-size: 1rem;
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
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .section-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }

  .section-add-btn:active {
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
    font-size: 0.9375rem;
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
    font-weight: 500;
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
    font-weight: 500;
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
    font-size: 0.9375rem;
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
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    background: var(--color-bg-secondary, #f5f5f5);
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    flex-shrink: 0;
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
    font-size: 0.8125rem;
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
    font-size: 0.875rem;
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
