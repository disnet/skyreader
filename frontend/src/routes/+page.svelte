<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import { shareReadingStore } from '$lib/stores/shareReading.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { keyboardStore } from '$lib/stores/keyboard.svelte';
  import { api } from '$lib/services/api';
  import ArticleCard from '$lib/components/ArticleCard.svelte';
  import ShareCard from '$lib/components/ShareCard.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LoadingState from '$lib/components/LoadingState.svelte';
  import PopoverMenu from '$lib/components/PopoverMenu.svelte';
  import { goto } from '$app/navigation';
  import type { Article, FeedItem, SocialShare, CombinedFeedItem, UserShare } from '$lib/types';

  let allArticles = $state<Article[]>([]);
  let isLoading = $state(true);
  let selectedIndex = $state(-1);
  let expandedIndex = $state(-1);
  let articleElements: HTMLElement[] = [];
  let showOnlyUnread = $state(true);

  // Snapshot of displayed items (doesn't change as you read items)
  let displayedArticles = $state<Article[]>([]);
  let displayedShares = $state<SocialShare[]>([]);
  let displayedUserShares = $state<UserShare[]>([]);
  let displayedCombined = $state<CombinedFeedItem[]>([]);

  // Map of guid -> article for looking up share content
  let articlesByGuid = $derived(new Map(allArticles.map(a => [a.guid, a])));

  // Cache for fetched articles (from backend, for shares not in local DB)
  let fetchedArticles = $state<Map<string, FeedItem>>(new Map());
  let fetchingArticles = $state<Set<string>>(new Set());

  async function fetchArticleContent(feedUrl: string, guid: string, itemUrl?: string) {
    if (fetchedArticles.has(guid) || fetchingArticles.has(guid)) return;

    fetchingArticles.add(guid);
    fetchingArticles = new Set(fetchingArticles);

    try {
      const article = await api.fetchArticle(feedUrl, guid, itemUrl);
      if (article) {
        fetchedArticles.set(guid, article);
        fetchedArticles = new Map(fetchedArticles);
      }
    } catch (e) {
      console.error('Failed to fetch article:', e);
    } finally {
      fetchingArticles.delete(guid);
      fetchingArticles = new Set(fetchingArticles);
    }
  }

  // Get filter params from URL
  let feedFilter = $derived($page.url.searchParams.get('feed'));
  let starredFilter = $derived($page.url.searchParams.get('starred'));
  let sharedFilter = $derived($page.url.searchParams.get('shared'));
  let sharerFilter = $derived($page.url.searchParams.get('sharer'));
  let followingFilter = $derived($page.url.searchParams.get('following'));
  let feedsFilter = $derived($page.url.searchParams.get('feeds'));

  // Determine current view mode
  // 'combined' = all view (articles + shares), 'shares' = following/sharer filter, 'userShares' = user's own shares, 'articles' = specific feed or starred or all feeds
  let viewMode = $derived.by((): 'articles' | 'shares' | 'userShares' | 'combined' => {
    if (sharedFilter) return 'userShares';
    if (sharerFilter || followingFilter) return 'shares';
    if (feedFilter || starredFilter || feedsFilter) return 'articles';
    return 'combined'; // "All" view shows both
  });

  // Build a filter key to detect when we need to recompute the snapshot
  let filterKey = $derived(
    `${feedFilter || ''}-${starredFilter || ''}-${sharedFilter || ''}-${sharerFilter || ''}-${followingFilter || ''}-${feedsFilter || ''}-${showOnlyUnread}`
  );

  // Track the last filter key and articles version to know when to snapshot
  let lastFilterKey = $state('');
  let lastSharesFilterKey = $state('');
  let lastArticlesVersion = $state(-1);
  let lastArticlesLength = $state(-1);
  let lastSharesLength = $state(-1);

  // Snapshot articles when filter or source data changes (not read state)
  $effect(() => {
    // Track these dependencies
    const currentKey = filterKey;
    const currentVersion = subscriptionsStore.articlesVersion;
    const currentArticles = allArticles;
    const currentLength = currentArticles.length;

    // Untrack comparisons to avoid loops
    const prevKey = untrack(() => lastFilterKey);
    const prevVersion = untrack(() => lastArticlesVersion);
    const prevLength = untrack(() => lastArticlesLength);

    if (currentKey !== prevKey || currentVersion !== prevVersion || currentLength !== prevLength) {
      // Take a snapshot using current read state (untracked to avoid reactivity)
      const readPositions = untrack(() => readingStore.readPositions);

      let filtered: Article[];
      if (feedFilter) {
        const feedId = parseInt(feedFilter);
        let feedArticles = currentArticles.filter(a => a.subscriptionId === feedId);
        // Apply showOnlyUnread filter for individual feeds too
        const onlyUnread = untrack(() => showOnlyUnread);
        if (onlyUnread) {
          feedArticles = feedArticles.filter(a => !readPositions.has(a.guid));
        }
        filtered = feedArticles;
      } else if (starredFilter) {
        filtered = currentArticles.filter(a => readPositions.get(a.guid)?.starred ?? false);
      } else {
        // Default: filter based on showOnlyUnread toggle
        const onlyUnread = untrack(() => showOnlyUnread);
        if (onlyUnread) {
          filtered = currentArticles.filter(a => !readPositions.has(a.guid));
        } else {
          filtered = [...currentArticles];
        }
      }

      displayedArticles = filtered;
      lastFilterKey = currentKey;
      lastArticlesVersion = currentVersion;
      lastArticlesLength = currentLength;
    }
  });

  // Snapshot shares when filter or source data changes
  $effect(() => {
    // Track these dependencies
    const shares = socialStore.shares;
    const currentKey = filterKey;

    // Untrack comparisons to avoid loops
    const prevKey = untrack(() => lastSharesFilterKey);
    const prevLength = untrack(() => lastSharesLength);

    if (currentKey !== prevKey || shares.length !== prevLength) {
      let filtered: SocialShare[];
      if (followingFilter) {
        filtered = [...shares];
      } else if (sharerFilter) {
        filtered = shares.filter(s => s.authorDid === sharerFilter);
      } else {
        // For "all" view and other views, include all shares
        filtered = [...shares];
      }

      // Apply showOnlyUnread filter for shares
      const onlyUnread = untrack(() => showOnlyUnread);
      const readPositions = untrack(() => shareReadingStore.shareReadPositions);
      if (onlyUnread && (followingFilter || sharerFilter)) {
        filtered = filtered.filter(s => !readPositions.has(s.recordUri));
      }

      displayedShares = filtered;
      lastSharesFilterKey = currentKey;
      lastSharesLength = shares.length;
    }
  });

  // Snapshot user's own shares when filter changes
  $effect(() => {
    const userShares = sharesStore.userShares;
    const currentKey = filterKey;

    if (sharedFilter) {
      // Convert Map to array and sort by createdAt descending
      const shares = Array.from(userShares.values());
      shares.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      displayedUserShares = shares;
    } else {
      displayedUserShares = [];
    }
  });

  // Combine articles and shares for the "all" view, sorted by date
  $effect(() => {
    // Track dependencies
    const articles = displayedArticles;
    const shares = displayedShares;
    const mode = viewMode;

    if (mode === 'combined') {
      const combined: CombinedFeedItem[] = [
        ...articles.map(item => ({
          type: 'article' as const,
          item,
          date: item.publishedAt
        })),
        ...shares.map(item => ({
          type: 'share' as const,
          item,
          date: item.itemPublishedAt || item.createdAt
        }))
      ];
      // Sort by date descending (newest first)
      combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      displayedCombined = combined;
    } else {
      displayedCombined = [];
    }
  });

  // Get page title based on filter
  let pageTitle = $derived.by(() => {
    if (feedFilter) {
      const sub = subscriptionsStore.subscriptions.find(s => s.id === parseInt(feedFilter));
      return sub?.title || 'Feed';
    }
    if (starredFilter) return 'Starred';
    if (sharedFilter) return 'Shared';
    if (followingFilter) return 'Following';
    if (sharerFilter) {
      const user = socialStore.followedUsers.find(u => u.did === sharerFilter);
      return user?.displayName || user?.handle || 'Shared';
    }
    if (feedsFilter) return 'Feeds';
    return 'All';
  });

  async function removeFeed(id: number) {
    if (confirm('Are you sure you want to remove this subscription?')) {
      await subscriptionsStore.remove(id);
      goto('/');
    }
  }

  onMount(async () => {
    if (auth.isAuthenticated) {
      await subscriptionsStore.load();
      await readingStore.load();
      await shareReadingStore.load();
      await sharesStore.load();
      await socialStore.loadFollowedUsers();
      await socialStore.loadFeed(true);
      allArticles = await subscriptionsStore.getAllArticles();

      // If we have subscriptions but no articles, use smart fetching
      if (subscriptionsStore.subscriptions.length > 0 && allArticles.length === 0) {
        // Check which feeds are ready on the backend
        const feedUrls = subscriptionsStore.subscriptions.map((s) => s.feedUrl);
        await subscriptionsStore.checkFeedStatuses(feedUrls);

        // Fetch all feeds (ready from cache, pending gradually from source)
        subscriptionsStore.fetchAllNewFeeds(2, 1000);

        // Give a moment for first batch then update display
        await new Promise((resolve) => setTimeout(resolve, 500));
        allArticles = await subscriptionsStore.getAllArticles();
      }
    }
    isLoading = false;
  });

  // Reset selection when filter changes
  $effect(() => {
    // Access filter values to create dependency
    feedFilter;
    starredFilter;
    sharedFilter;
    sharerFilter;
    followingFilter;
    feedsFilter;
    selectedIndex = -1;
    expandedIndex = -1;
  });

  // Reload articles when new ones are fetched
  $effect(() => {
    const version = subscriptionsStore.articlesVersion;
    if (version > 0) {
      subscriptionsStore.getAllArticles().then(articles => {
        allArticles = articles;
      });
    }
  });

  // Get current items based on view mode (uses snapshots)
  let currentItems = $derived.by(() => {
    const mode = viewMode;
    if (mode === 'combined') return displayedCombined;
    if (mode === 'shares') return displayedShares;
    if (mode === 'userShares') return displayedUserShares;
    return displayedArticles;
  });

  // Helper to get selected article info (for keyboard shortcuts)
  function getSelectedArticle(): { article: Article; sub: typeof subscriptionsStore.subscriptions[0] } | null {
    if (selectedIndex < 0) return null;
    const mode = viewMode;

    if (mode === 'articles') {
      const article = displayedArticles[selectedIndex];
      if (!article) return null;
      const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId);
      if (!sub) return null;
      return { article, sub };
    } else if (mode === 'combined') {
      const feedItem = displayedCombined[selectedIndex];
      if (!feedItem || feedItem.type !== 'article') return null;
      const article = feedItem.item;
      const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId);
      if (!sub) return null;
      return { article, sub };
    } else if (mode === 'userShares') {
      const share = displayedUserShares[selectedIndex];
      if (!share) return null;
      const localArticle = articlesByGuid.get(share.articleGuid);
      if (localArticle) {
        const sub = subscriptionsStore.subscriptions.find(s => s.id === localArticle.subscriptionId);
        if (sub) return { article: localArticle, sub };
      }
      // For user shares without local article, create a minimal article object
      return {
        article: {
          guid: share.articleGuid,
          url: share.articleUrl,
          title: share.articleTitle || share.articleUrl,
          author: share.articleAuthor,
          summary: share.articleDescription,
          imageUrl: share.articleImage,
          publishedAt: share.articlePublishedAt || share.createdAt,
          subscriptionId: 0,
          fetchedAt: Date.now()
        },
        sub: { atUri: '', feedUrl: share.feedUrl || '', id: 0, title: '' } as typeof subscriptionsStore.subscriptions[0]
      };
    }
    return null;
  }

  // Open selected item in new tab
  function openSelectedItem() {
    if (selectedIndex < 0) return;
    const items = currentItems;
    const item = items[selectedIndex];
    const mode = viewMode;
    let url: string;
    if (mode === 'combined') {
      const combined = item as CombinedFeedItem;
      url = combined.type === 'article' ? combined.item.url : combined.item.itemUrl;
    } else if (mode === 'shares') {
      url = (item as SocialShare).itemUrl;
    } else if (mode === 'userShares') {
      url = (item as UserShare).articleUrl;
    } else {
      url = (item as Article).url;
    }
    window.open(url, '_blank');
  }

  // Toggle star on selected item
  function toggleSelectedStar() {
    const selected = getSelectedArticle();
    if (selected) {
      readingStore.toggleStar(selected.article.guid);
    }
  }

  // Share/unshare selected item
  function toggleSelectedShare() {
    const selected = getSelectedArticle();
    if (!selected) return;

    const { article, sub } = selected;
    if (sharesStore.isShared(article.guid)) {
      sharesStore.unshare(article.guid);
    } else {
      sharesStore.share(
        sub.atUri,
        sub.feedUrl,
        article.guid,
        article.url,
        article.title,
        article.author,
        article.summary,
        article.imageUrl,
        article.publishedAt
      );
    }
  }

  // Toggle read/unread on selected item
  function toggleSelectedRead() {
    if (selectedIndex < 0) return;
    const mode = viewMode;

    if (mode === 'articles') {
      const article = displayedArticles[selectedIndex];
      if (!article) return;
      const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId);
      if (!sub) return;

      if (readingStore.isRead(article.guid)) {
        readingStore.markAsUnread(article.guid);
      } else {
        readingStore.markAsRead(sub.atUri, article.guid, article.url, article.title);
      }
    } else if (mode === 'combined') {
      const feedItem = displayedCombined[selectedIndex];
      if (!feedItem) return;

      if (feedItem.type === 'article') {
        const article = feedItem.item;
        const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId);
        if (!sub) return;

        if (readingStore.isRead(article.guid)) {
          readingStore.markAsUnread(article.guid);
        } else {
          readingStore.markAsRead(sub.atUri, article.guid, article.url, article.title);
        }
      } else {
        const share = feedItem.item;
        if (shareReadingStore.isRead(share.recordUri)) {
          shareReadingStore.markAsUnread(share.recordUri);
        } else {
          shareReadingStore.markAsRead(share.recordUri, share.authorDid, share.itemUrl, share.itemTitle);
        }
      }
    } else if (mode === 'shares') {
      const share = displayedShares[selectedIndex];
      if (!share) return;

      if (shareReadingStore.isRead(share.recordUri)) {
        shareReadingStore.markAsUnread(share.recordUri);
      } else {
        shareReadingStore.markAsRead(share.recordUri, share.authorDid, share.itemUrl, share.itemTitle);
      }
    }
  }

  // Refresh current view
  async function refreshView() {
    if (feedFilter) {
      // Refresh specific feed
      const feedId = parseInt(feedFilter);
      await subscriptionsStore.fetchFeed(feedId, true);
    } else {
      // Refresh all feeds
      await subscriptionsStore.fetchAllNewFeeds(2, 500);
    }
    allArticles = await subscriptionsStore.getAllArticles();
  }

  // Register keyboard shortcuts
  onMount(() => {
    // Navigation shortcuts
    keyboardStore.register({
      key: 'j',
      description: 'Next item',
      category: 'Navigation',
      action: () => {
        if (currentItems.length > 0) {
          selectItem(Math.min(selectedIndex + 1, currentItems.length - 1));
        }
      },
      condition: () => auth.isAuthenticated && currentItems.length > 0,
    });

    keyboardStore.register({
      key: 'ArrowDown',
      description: 'Next item',
      category: 'Navigation',
      action: () => {
        if (currentItems.length > 0) {
          selectItem(Math.min(selectedIndex + 1, currentItems.length - 1));
        }
      },
      condition: () => auth.isAuthenticated && currentItems.length > 0,
    });

    keyboardStore.register({
      key: 'k',
      description: 'Previous item',
      category: 'Navigation',
      action: () => {
        if (currentItems.length > 0) {
          selectItem(Math.max(selectedIndex - 1, 0));
        }
      },
      condition: () => auth.isAuthenticated && currentItems.length > 0,
    });

    keyboardStore.register({
      key: 'ArrowUp',
      description: 'Previous item',
      category: 'Navigation',
      action: () => {
        if (currentItems.length > 0) {
          selectItem(Math.max(selectedIndex - 1, 0));
        }
      },
      condition: () => auth.isAuthenticated && currentItems.length > 0,
    });

    keyboardStore.register({
      key: 'o',
      description: 'Open in new tab',
      category: 'Navigation',
      action: openSelectedItem,
      condition: () => auth.isAuthenticated && selectedIndex >= 0,
    });

    keyboardStore.register({
      key: 'Enter',
      description: 'Toggle expand',
      category: 'Navigation',
      action: () => {
        if (selectedIndex >= 0) {
          expandedIndex = expandedIndex === selectedIndex ? -1 : selectedIndex;
        }
      },
      condition: () => auth.isAuthenticated && selectedIndex >= 0,
    });

    // Article action shortcuts
    keyboardStore.register({
      key: 's',
      description: 'Toggle star',
      category: 'Article',
      action: toggleSelectedStar,
      condition: () => auth.isAuthenticated && selectedIndex >= 0,
    });

    keyboardStore.register({
      key: 'S',
      shift: true,
      description: 'Share/unshare',
      category: 'Article',
      action: toggleSelectedShare,
      condition: () => auth.isAuthenticated && selectedIndex >= 0,
    });

    keyboardStore.register({
      key: 'm',
      description: 'Mark read/unread',
      category: 'Article',
      action: toggleSelectedRead,
      condition: () => auth.isAuthenticated && selectedIndex >= 0,
    });

    // Other shortcuts
    keyboardStore.register({
      key: 'u',
      description: 'Toggle unread filter',
      category: 'Other',
      action: () => {
        showOnlyUnread = !showOnlyUnread;
      },
      condition: () => auth.isAuthenticated && !starredFilter && !sharedFilter,
    });

    keyboardStore.register({
      key: 'r',
      description: 'Refresh',
      category: 'Other',
      action: refreshView,
      condition: () => auth.isAuthenticated,
    });
  });

  // Unregister shortcuts when component unmounts
  onDestroy(() => {
    keyboardStore.unregister('j');
    keyboardStore.unregister('k');
    keyboardStore.unregister('ArrowDown');
    keyboardStore.unregister('ArrowUp');
    keyboardStore.unregister('o');
    keyboardStore.unregister('Enter');
    keyboardStore.unregister('s');
    keyboardStore.unregister('S', true);
    keyboardStore.unregister('m');
    keyboardStore.unregister('u');
    keyboardStore.unregister('r');
  });

  async function selectItem(index: number) {
    if (index === selectedIndex) return;

    const mode = viewMode;
    // Mark as read when selecting articles or shares
    if (mode === 'articles') {
      const article = displayedArticles[index];
      const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId);
      if (sub && !readingStore.isRead(article.guid)) {
        readingStore.markAsRead(sub.atUri, article.guid, article.url, article.title);
      }
    } else if (mode === 'shares') {
      const share = displayedShares[index];
      if (!shareReadingStore.isRead(share.recordUri)) {
        shareReadingStore.markAsRead(share.recordUri, share.authorDid, share.itemUrl, share.itemTitle);
      }
    } else if (mode === 'combined') {
      const feedItem = displayedCombined[index];
      if (feedItem.type === 'article') {
        const article = feedItem.item;
        const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId);
        if (sub && !readingStore.isRead(article.guid)) {
          readingStore.markAsRead(sub.atUri, article.guid, article.url, article.title);
        }
      } else {
        const share = feedItem.item;
        if (!shareReadingStore.isRead(share.recordUri)) {
          shareReadingStore.markAsRead(share.recordUri, share.authorDid, share.itemUrl, share.itemTitle);
        }
      }
    }

    selectedIndex = index;
    expandedIndex = -1; // Reset expanded when selecting new item

    await tick(); // Wait for DOM to update
    scrollToCenter();
  }

  function scrollToCenter() {
    const el = articleElements[selectedIndex];
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const targetY = window.innerHeight / 3;
    const offset = rect.top - targetY;

    window.scrollBy({ top: offset, behavior: 'instant' });
  }
</script>

{#if !auth.isAuthenticated}
  <div class="welcome">
    <h1>Welcome to Skyreader</h1>
    <p>A decentralized RSS reader built on the AT Protocol.</p>
    <ul class="features">
      <li>Store your subscriptions in your own data server</li>
      <li>See what articles people you follow are sharing</li>
      <li>Works offline with automatic sync</li>
    </ul>
    <a href="/auth/login" class="btn btn-primary">Login with Bluesky</a>
  </div>
{:else}
  <div class="feed-page">
    <div class="feed-header">
      <button class="mobile-menu-btn" onclick={() => sidebarStore.toggleMobile()} aria-label="Open menu">
        &lt;
      </button>
      <div class="feed-title-group">
        <h1>{pageTitle}</h1>
        {#if feedFilter}
          <PopoverMenu
            items={[
              {
                label: 'Delete',
                icon: '🗑',
                variant: 'danger',
                onclick: () => removeFeed(parseInt(feedFilter)),
              },
            ]}
          />
        {/if}
      </div>
      {#if !starredFilter && !sharedFilter}
        <div class="view-toggle">
          <button
            class:active={showOnlyUnread}
            onclick={() => showOnlyUnread = true}
          >Unread</button>
          <button
            class:active={!showOnlyUnread}
            onclick={() => showOnlyUnread = false}
          >All</button>
        </div>
      {/if}
    </div>

    {#if isLoading && currentItems.length === 0}
      <LoadingState />
    {:else if currentItems.length === 0}
      {#if starredFilter}
        <EmptyState title="No starred articles" description="Star articles to save them for later" />
      {:else if sharedFilter}
        <EmptyState title="No shared articles" description="Share articles to see them here" />
      {:else if followingFilter}
        {#if showOnlyUnread}
          <EmptyState title="No unread shares" description="You're all caught up on shares from people you follow" />
        {:else}
          <EmptyState title="No shared articles" description="People you follow haven't shared any articles yet" />
        {/if}
      {:else if sharerFilter}
        {#if showOnlyUnread}
          <EmptyState title="No unread shares" description="You're all caught up on shares from this user" />
        {:else}
          <EmptyState title="No shares from this user" description="This user hasn't shared any articles yet" />
        {/if}
      {:else if feedFilter}
        {#if showOnlyUnread}
          <EmptyState title="No unread articles" description="You're all caught up on this feed" />
        {:else}
          <EmptyState title="No articles" description="This feed has no articles" />
        {/if}
      {:else if feedsFilter}
        <EmptyState title="No unread articles" description="You're all caught up on your feeds" />
      {:else if showOnlyUnread}
        <EmptyState title="No unread articles" description="You're all caught up!" />
      {:else}
        <EmptyState
          title="No articles"
          description="Add some subscriptions using the + button in the sidebar"
        />
      {/if}
    {:else if viewMode === 'combined'}
      <!-- Combined view (articles + shares) -->
      <div class="article-list">
        {#each displayedCombined as feedItem, index (feedItem.type === 'article' ? feedItem.item.guid : feedItem.item.recordUri)}
          <div bind:this={articleElements[index]}>
            {#if feedItem.type === 'article'}
              {@const article = feedItem.item}
              {@const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId)}
              <ArticleCard
                {article}
                siteUrl={sub?.siteUrl}
                isRead={readingStore.isRead(article.guid)}
                isStarred={readingStore.isStarred(article.guid)}
                isShared={sharesStore.isShared(article.guid)}
                shareNote={sharesStore.getShareNote(article.guid)}
                selected={selectedIndex === index}
                expanded={expandedIndex === index}
                onToggleStar={() => readingStore.toggleStar(article.guid)}
                onShare={() => sharesStore.share(
                  sub?.atUri || '',
                  sub?.feedUrl || '',
                  article.guid,
                  article.url,
                  article.title,
                  article.author,
                  article.summary,
                  article.imageUrl,
                  article.publishedAt
                )}
                onUnshare={() => sharesStore.unshare(article.guid)}
                onSelect={() => {
                  if (selectedIndex === index) {
                    selectedIndex = -1;
                    expandedIndex = -1;
                  } else {
                    selectItem(index);
                  }
                }}
                onExpand={async () => {
                  if (expandedIndex === index) {
                    expandedIndex = -1;
                  } else {
                    expandedIndex = index;
                    await tick();
                    scrollToCenter();
                  }
                }}
              />
            {:else}
              {@const share = feedItem.item}
              {@const localArticle = share.itemGuid ? articlesByGuid.get(share.itemGuid) : undefined}
              {@const remoteArticle = share.itemGuid ? fetchedArticles.get(share.itemGuid) : undefined}
              {@const isFetching = share.itemGuid ? fetchingArticles.has(share.itemGuid) : false}
              <ShareCard
                {share}
                {localArticle}
                {remoteArticle}
                {isFetching}
                isRead={shareReadingStore.isRead(share.recordUri)}
                selected={selectedIndex === index}
                expanded={expandedIndex === index}
                onSelect={() => {
                  if (selectedIndex === index) {
                    selectedIndex = -1;
                    expandedIndex = -1;
                  } else {
                    selectItem(index);
                  }
                }}
                onExpand={async () => {
                  if (expandedIndex === index) {
                    expandedIndex = -1;
                  } else {
                    expandedIndex = index;
                    await tick();
                    scrollToCenter();
                  }
                }}
                onFetchContent={() => {
                  const hasLocalContent = localArticle?.content || localArticle?.summary;
                  const hasRemoteContent = remoteArticle?.content || remoteArticle?.summary;
                  if (share.feedUrl && share.itemGuid && !hasLocalContent && !hasRemoteContent) {
                    fetchArticleContent(share.feedUrl, share.itemGuid, share.itemUrl);
                  }
                }}
              />
            {/if}
          </div>
        {/each}
      </div>
    {:else if viewMode === 'shares'}
      <!-- Social shares view -->
      <div class="article-list">
        {#each displayedShares as share, index (share.recordUri)}
          {@const localArticle = share.itemGuid ? articlesByGuid.get(share.itemGuid) : undefined}
          {@const remoteArticle = share.itemGuid ? fetchedArticles.get(share.itemGuid) : undefined}
          {@const isFetching = share.itemGuid ? fetchingArticles.has(share.itemGuid) : false}
          <div bind:this={articleElements[index]}>
            <ShareCard
              {share}
              {localArticle}
              {remoteArticle}
              {isFetching}
              isRead={shareReadingStore.isRead(share.recordUri)}
              selected={selectedIndex === index}
              expanded={expandedIndex === index}
              onSelect={() => {
                if (selectedIndex === index) {
                  selectedIndex = -1;
                  expandedIndex = -1;
                } else {
                  selectItem(index);
                }
              }}
              onExpand={async () => {
                if (expandedIndex === index) {
                  expandedIndex = -1;
                } else {
                  expandedIndex = index;
                  await tick();
                  scrollToCenter();
                }
              }}
              onFetchContent={() => {
                const hasLocalContent = localArticle?.content || localArticle?.summary;
                const hasRemoteContent = remoteArticle?.content || remoteArticle?.summary;
                if (share.feedUrl && share.itemGuid && !hasLocalContent && !hasRemoteContent) {
                  fetchArticleContent(share.feedUrl, share.itemGuid, share.itemUrl);
                }
              }}
            />
          </div>
        {/each}
      </div>
    {:else if viewMode === 'userShares'}
      <!-- User's own shares view -->
      <div class="article-list">
        {#each displayedUserShares as share, index (share.articleGuid)}
          {@const localArticle = articlesByGuid.get(share.articleGuid)}
          {@const article = localArticle || {
            guid: share.articleGuid,
            url: share.articleUrl,
            title: share.articleTitle || share.articleUrl,
            author: share.articleAuthor,
            summary: share.articleDescription,
            imageUrl: share.articleImage,
            publishedAt: share.articlePublishedAt || share.createdAt,
            subscriptionId: 0,
            fetchedAt: Date.now()
          }}
          {@const sub = localArticle ? subscriptionsStore.subscriptions.find(s => s.id === localArticle.subscriptionId) : undefined}
          <div bind:this={articleElements[index]}>
            <ArticleCard
              {article}
              siteUrl={sub?.siteUrl}
              isRead={readingStore.isRead(article.guid)}
              isStarred={readingStore.isStarred(article.guid)}
              isShared={true}
              shareNote={share.note}
              selected={selectedIndex === index}
              expanded={expandedIndex === index}
              onToggleStar={() => readingStore.toggleStar(article.guid)}
              onUnshare={() => sharesStore.unshare(share.articleGuid)}
              onSelect={() => {
                if (selectedIndex === index) {
                  selectedIndex = -1;
                  expandedIndex = -1;
                } else {
                  selectItem(index);
                }
              }}
              onExpand={async () => {
                if (expandedIndex === index) {
                  expandedIndex = -1;
                } else {
                  expandedIndex = index;
                  await tick();
                  scrollToCenter();
                }
              }}
            />
          </div>
        {/each}
      </div>
    {:else}
      <!-- Articles view -->
      <div class="article-list">
        {#each displayedArticles as article, index (article.guid)}
          {@const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId)}
          <div bind:this={articleElements[index]}>
            <ArticleCard
              {article}
              siteUrl={sub?.siteUrl}
              isRead={readingStore.isRead(article.guid)}
              isStarred={readingStore.isStarred(article.guid)}
              isShared={sharesStore.isShared(article.guid)}
              shareNote={sharesStore.getShareNote(article.guid)}
              selected={selectedIndex === index}
              expanded={expandedIndex === index}
              onToggleStar={() => readingStore.toggleStar(article.guid)}
              onShare={() => sharesStore.share(
                sub?.atUri || '',
                sub?.feedUrl || '',
                article.guid,
                article.url,
                article.title,
                article.author,
                article.summary,
                article.imageUrl,
                article.publishedAt
              )}
              onUnshare={() => sharesStore.unshare(article.guid)}
              onSelect={() => {
                if (selectedIndex === index) {
                  selectedIndex = -1;
                  expandedIndex = -1;
                } else {
                  selectItem(index);
                }
              }}
              onExpand={async () => {
                if (expandedIndex === index) {
                  expandedIndex = -1;
                } else {
                  expandedIndex = index;
                  await tick();
                  scrollToCenter();
                }
              }}
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .welcome {
    max-width: 600px;
    margin: 4rem auto;
    text-align: center;
  }

  .welcome h1 {
    font-size: 2.5rem;
    margin-bottom: 1rem;
  }

  .welcome p {
    font-size: 1.25rem;
    color: var(--color-text-secondary);
    margin-bottom: 2rem;
  }

  .features {
    list-style: none;
    margin-bottom: 2rem;
    text-align: left;
    display: inline-block;
  }

  .features li {
    padding: 0.5rem 0;
    padding-left: 1.5rem;
    position: relative;
  }

  .features li::before {
    content: '✓';
    position: absolute;
    left: 0;
    color: var(--color-success);
  }

  .feed-page {
    max-width: 800px;
    margin: 0 auto;
  }

  .feed-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    width: 100%;
  }

  .feed-title-group {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .feed-header h1 {
    font-size: 1.5rem;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-menu-btn {
    display: none;
    background: none;
    border: none;
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0.25rem;
    color: var(--color-text);
  }

  .view-toggle {
    display: flex;
    background: var(--color-bg-secondary);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }

  .view-toggle button {
    padding: 0.375rem 0.75rem;
    border: none;
    background: transparent;
    border-radius: 4px;
    font-size: 0.875rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
    font-family: inherit;
  }

  .view-toggle button.active {
    background: var(--color-primary);
    color: white;
  }

  .view-toggle button:hover:not(.active) {
    background: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .article-list {
    display: flex;
    flex-direction: column;
  }

  .article-list > div {
    border-bottom: 1px solid var(--color-border);
  }

  .article-list > div:last-child {
    border-bottom: none;
  }

  /* Mobile styles */
  @media (max-width: 768px) {
    .feed-page {
      padding-top: 3.5rem;
    }

    .feed-header {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 40;
      background: var(--color-bg);
      padding: 0.75rem 1rem;
      margin-bottom: 0;
      border-bottom: 1px solid var(--color-border);
    }

    .feed-header h1 {
      font-size: 1.125rem;
    }

    .mobile-menu-btn {
      display: block;
    }
  }
</style>
