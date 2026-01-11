<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import { api } from '$lib/services/api';
  import { formatRelativeDate } from '$lib/utils/date';
  import ArticleCard from '$lib/components/ArticleCard.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import LoadingState from '$lib/components/LoadingState.svelte';
  import type { Article, FeedItem, SocialShare } from '$lib/types';

  let allArticles = $state<Article[]>([]);
  let isLoading = $state(true);
  let selectedIndex = $state(-1);
  let expandedIndex = $state(-1);
  let articleElements: HTMLElement[] = [];
  let showOnlyUnread = $state(true);

  // Snapshot of displayed items (doesn't change as you read items)
  let displayedArticles = $state<Article[]>([]);
  let displayedShares = $state<SocialShare[]>([]);

  // Map of guid -> article for looking up share content
  let articlesByGuid = $derived(new Map(allArticles.map(a => [a.guid, a])));

  // Cache for fetched articles (from backend, for shares not in local DB)
  let fetchedArticles = $state<Map<string, FeedItem>>(new Map());
  let fetchingArticles = $state<Set<string>>(new Set());

  async function fetchArticleContent(feedUrl: string, guid: string) {
    if (fetchedArticles.has(guid) || fetchingArticles.has(guid)) return;

    fetchingArticles.add(guid);
    fetchingArticles = new Set(fetchingArticles);

    try {
      const article = await api.fetchArticle(feedUrl, guid);
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
  let sharerFilter = $derived($page.url.searchParams.get('sharer'));
  let followingFilter = $derived($page.url.searchParams.get('following'));

  // Determine current view mode
  let viewMode = $derived<'articles' | 'shares'>(sharerFilter || followingFilter ? 'shares' : 'articles');

  // Build a filter key to detect when we need to recompute the snapshot
  let filterKey = $derived(
    `${feedFilter || ''}-${starredFilter || ''}-${sharerFilter || ''}-${followingFilter || ''}-${showOnlyUnread}`
  );

  // Track the last filter key and articles version to know when to snapshot
  let lastFilterKey = $state('');
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
        filtered = currentArticles.filter(a => a.subscriptionId === feedId);
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
    const prevKey = untrack(() => lastFilterKey);
    const prevLength = untrack(() => lastSharesLength);

    if (currentKey !== prevKey || shares.length !== prevLength) {
      let filtered: SocialShare[];
      if (followingFilter) {
        filtered = [...shares];
      } else if (sharerFilter) {
        filtered = shares.filter(s => s.authorDid === sharerFilter);
      } else {
        filtered = [];
      }

      displayedShares = filtered;
      lastSharesLength = shares.length;
    }
  });

  // Get page title based on filter
  let pageTitle = $derived(() => {
    if (feedFilter) {
      const sub = subscriptionsStore.subscriptions.find(s => s.id === parseInt(feedFilter));
      return sub?.title || 'Feed';
    }
    if (starredFilter) return 'Starred';
    if (followingFilter) return 'Following';
    if (sharerFilter) {
      const user = socialStore.followedUsers.find(u => u.did === sharerFilter);
      return user?.displayName || user?.handle || 'Shared';
    }
    return 'All';
  });

  onMount(async () => {
    if (auth.isAuthenticated) {
      await subscriptionsStore.load();
      await readingStore.load();
      await sharesStore.load();
      await socialStore.loadFollowedUsers();
      await socialStore.loadFeed(true);
      allArticles = await subscriptionsStore.getAllArticles();

      // If we have subscriptions but no articles, fetch feeds (first login scenario)
      if (subscriptionsStore.subscriptions.length > 0 && allArticles.length === 0) {
        for (const sub of subscriptionsStore.subscriptions) {
          if (sub.id) {
            await subscriptionsStore.fetchFeed(sub.id, false);
          }
        }
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
    sharerFilter;
    followingFilter;
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
  let currentItems = $derived(() => {
    return viewMode === 'shares' ? displayedShares : displayedArticles;
  });

  function handleKeydown(e: KeyboardEvent) {
    if (!auth.isAuthenticated || currentItems().length === 0) return;

    // Ignore if user is typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    const items = currentItems();
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      selectItem(Math.min(selectedIndex + 1, items.length - 1));
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectItem(Math.max(selectedIndex - 1, 0));
    } else if (e.key === 'o' && selectedIndex >= 0) {
      e.preventDefault();
      const item = items[selectedIndex];
      const url = viewMode === 'shares' ? (item as SocialShare).itemUrl : (item as Article).url;
      window.open(url, '_blank');
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      expandedIndex = expandedIndex === selectedIndex ? -1 : selectedIndex;
    }
  }

  async function selectItem(index: number) {
    if (index === selectedIndex) return;

    // Mark as read when selecting articles (not shares)
    if (viewMode === 'articles') {
      const article = displayedArticles[index];
      const sub = subscriptionsStore.subscriptions.find(s => s.id === article.subscriptionId);
      if (sub && !readingStore.isRead(article.guid)) {
        readingStore.markAsRead(sub.atUri, article.guid, article.url, article.title);
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

  function getFaviconUrl(url: string): string {
    try {
      const domain = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch {
      return '';
    }
  }

</script>

<svelte:window onkeydown={handleKeydown} />

{#if !auth.isAuthenticated}
  <div class="welcome">
    <h1>Welcome to AT-RSS</h1>
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
      <h1>{pageTitle()}</h1>
      {#if !feedFilter && !starredFilter && !sharerFilter && !followingFilter}
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

    {#if isLoading && currentItems().length === 0}
      <LoadingState />
    {:else if currentItems().length === 0}
      {#if starredFilter}
        <EmptyState title="No starred articles" description="Star articles to save them for later" />
      {:else if followingFilter}
        <EmptyState title="No shared articles" description="People you follow haven't shared any articles yet" />
      {:else if sharerFilter}
        <EmptyState title="No shares from this user" description="This user hasn't shared any articles yet" />
      {:else if feedFilter}
        <EmptyState title="No unread articles" description="You're all caught up on this feed" />
      {:else if showOnlyUnread}
        <EmptyState title="No unread articles" description="You're all caught up!" />
      {:else}
        <EmptyState
          title="No articles"
          description="Add some subscriptions to get started"
          actionHref="/feeds"
          actionText="Manage Subscriptions"
        />
      {/if}
    {:else if viewMode === 'shares'}
      <!-- Social shares view -->
      <div class="article-list">
        {#each displayedShares as share, index (share.recordUri)}
          {@const localArticle = share.itemGuid ? articlesByGuid.get(share.itemGuid) : undefined}
          {@const remoteArticle = share.itemGuid ? fetchedArticles.get(share.itemGuid) : undefined}
          {@const articleContent = localArticle?.content || localArticle?.summary || remoteArticle?.content || remoteArticle?.summary}
          {@const isFetching = share.itemGuid ? fetchingArticles.has(share.itemGuid) : false}
          <div bind:this={articleElements[index]}>
            <div
              class="share-item"
              class:selected={selectedIndex === index}
              class:expanded={expandedIndex === index}
            >
              <div class="share-attribution">
                shared by <a href="/?sharer={share.authorDid}" class="share-author-link">@{share.authorHandle}</a>
              </div>
              <button class="share-header" onclick={() => {
                if (selectedIndex === index) {
                  selectedIndex = -1;
                  expandedIndex = -1;
                } else {
                  selectItem(index);
                  // Fetch article content if needed
                  if (share.feedUrl && share.itemGuid && !localArticle && !remoteArticle) {
                    fetchArticleContent(share.feedUrl, share.itemGuid);
                  }
                }
              }}>
                <img src={getFaviconUrl(share.itemUrl)} alt="" class="favicon" />
                {#if selectedIndex === index || expandedIndex === index}
                  <a href={share.itemUrl} target="_blank" rel="noopener" class="share-title-link" onclick={(e) => e.stopPropagation()}>
                    {share.itemTitle || share.itemUrl}
                  </a>
                {:else}
                  <span class="share-title">{share.itemTitle || share.itemUrl}</span>
                {/if}
                <span class="share-date">{formatRelativeDate(share.itemPublishedAt || share.createdAt)}</span>
              </button>
              {#if selectedIndex === index || expandedIndex === index}
                <div class="share-content">
                  <div class="share-actions">
                    <a href={share.itemUrl} target="_blank" rel="noopener" class="action-btn" onclick={(e) => e.stopPropagation()}>
                      ↗ Open
                    </a>
                  </div>
                  {#if share.note}
                    <blockquote class="share-note">{share.note}</blockquote>
                  {/if}
                  {#if articleContent}
                    <div class="share-body">
                      {@html articleContent}
                    </div>
                  {:else if isFetching}
                    <p class="share-loading">Loading article content...</p>
                  {:else if share.itemDescription}
                    <p class="share-description">{share.itemDescription}</p>
                  {/if}
                </div>
              {/if}
            </div>
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
              onShareWithNote={(note) => sharesStore.shareWithNote(
                sub?.atUri || '',
                sub?.feedUrl || '',
                article.guid,
                article.url,
                article.title,
                article.author,
                article.summary,
                article.imageUrl,
                article.publishedAt,
                note
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
                expandedIndex = index;
                await tick();
                scrollToCenter();
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
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .feed-header h1 {
    font-size: 1.5rem;
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

  /* Share items styling */
  .share-item {
    transition: background-color 0.15s ease;
  }

  .share-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .share-item.selected,
  .share-item.expanded {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
  }

  .share-attribution {
    font-size: 0.75rem;
    color: var(--color-text-secondary);
    padding: 0.5rem 0.5rem 0;
  }

  .share-author-link {
    color: var(--color-text-secondary);
    text-decoration: none;
  }

  .share-author-link:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .share-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.5rem 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }

  .share-item .favicon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .share-title {
    flex: 1;
    font-weight: 500;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .share-title-link {
    flex: 1;
    font-weight: 500;
    color: var(--color-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-decoration: none;
  }

  .share-title-link:hover {
    text-decoration: underline;
  }

  .share-date {
    flex-shrink: 0;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .share-content {
    padding: 0 0.5rem 1rem;
  }

  .share-actions {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .share-item .action-btn {
    background: none;
    border: none;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    padding: 0;
    cursor: pointer;
    text-decoration: none;
  }

  .share-item .action-btn:hover {
    color: var(--color-primary);
  }

  .share-note {
    border-left: 3px solid var(--color-primary);
    margin: 0 0 0.75rem 0;
    padding-left: 1rem;
    font-style: italic;
    color: var(--color-text);
  }

  .share-description {
    font-size: 0.9375rem;
    color: var(--color-text-secondary);
    margin-bottom: 0.75rem;
    line-height: 1.5;
  }

  .share-loading {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    margin-top: 0.5rem;
    font-style: italic;
  }

  .share-body {
    font-size: 0.9375rem;
    line-height: 1.7;
    color: var(--color-text);
    overflow-wrap: break-word;
  }

  .share-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 0.75rem 0;
  }

  .share-body :global(a) {
    color: var(--color-primary);
  }

  .share-body :global(pre) {
    background: var(--color-bg-secondary);
    padding: 0.75rem;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.8rem;
  }

  .share-body :global(blockquote) {
    border-left: 3px solid var(--color-border);
    margin: 0.75rem 0;
    padding-left: 1rem;
    color: var(--color-text-secondary);
  }

  @media (prefers-color-scheme: dark) {
    .share-item:hover,
    .share-item.selected,
    .share-item.expanded {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
