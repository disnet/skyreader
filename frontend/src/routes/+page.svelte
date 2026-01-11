<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { page } from '$app/stores';
  import { auth } from '$lib/stores/auth.svelte';
  import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
  import { readingStore } from '$lib/stores/reading.svelte';
  import { sharesStore } from '$lib/stores/shares.svelte';
  import { socialStore } from '$lib/stores/social.svelte';
  import ArticleCard from '$lib/components/ArticleCard.svelte';
  import type { Article, SocialShare } from '$lib/types';

  let allArticles = $state<Article[]>([]);
  let isLoading = $state(true);
  let selectedIndex = $state(-1);
  let expandedIndex = $state(-1);
  let articleElements: HTMLElement[] = [];

  // Snapshot of displayed items (doesn't change as you read items)
  let displayedArticles = $state<Article[]>([]);
  let displayedShares = $state<SocialShare[]>([]);

  // Get filter params from URL
  let feedFilter = $derived($page.url.searchParams.get('feed'));
  let starredFilter = $derived($page.url.searchParams.get('starred'));
  let sharerFilter = $derived($page.url.searchParams.get('sharer'));
  let followingFilter = $derived($page.url.searchParams.get('following'));

  // Determine current view mode
  let viewMode = $derived<'articles' | 'shares'>(sharerFilter || followingFilter ? 'shares' : 'articles');

  // Build a filter key to detect when we need to recompute the snapshot
  let filterKey = $derived(
    `${feedFilter || ''}-${starredFilter || ''}-${sharerFilter || ''}-${followingFilter || ''}`
  );

  // Track the last filter key and articles version to know when to snapshot
  let lastFilterKey = $state('');
  let lastArticlesVersion = $state(-1);
  let lastSharesLength = $state(-1);

  // Snapshot articles when filter or source data changes (not read state)
  $effect(() => {
    // Track these dependencies
    const currentKey = filterKey;
    const currentVersion = subscriptionsStore.articlesVersion;
    const currentArticles = allArticles;

    // Untrack comparisons to avoid loops
    const prevKey = untrack(() => lastFilterKey);
    const prevVersion = untrack(() => lastArticlesVersion);

    if (currentKey !== prevKey || currentVersion !== prevVersion) {
      // Take a snapshot using current read state (untracked to avoid reactivity)
      const readPositions = untrack(() => readingStore.readPositions);

      let filtered: Article[];
      if (feedFilter) {
        const feedId = parseInt(feedFilter);
        filtered = currentArticles.filter(a => a.subscriptionId === feedId);
      } else if (starredFilter) {
        filtered = currentArticles.filter(a => readPositions.get(a.guid)?.starred ?? false);
      } else {
        // Default: show only unread articles
        filtered = currentArticles.filter(a => !readPositions.has(a.guid));
      }

      displayedArticles = filtered;
      lastFilterKey = currentKey;
      lastArticlesVersion = currentVersion;
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
    return 'All Unread';
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

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffHours < 1) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      return `${diffMinutes}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
      return `${diffDays}d ago`;
    }
    return date.toLocaleDateString();
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
    </div>

    {#if isLoading && currentItems().length === 0}
      <div class="loading-state">Loading...</div>
    {:else if currentItems().length === 0}
      <div class="empty-state">
        {#if starredFilter}
          <h2>No starred articles</h2>
          <p>Star articles to save them for later</p>
        {:else if followingFilter}
          <h2>No shared articles</h2>
          <p>People you follow haven't shared any articles yet</p>
        {:else if sharerFilter}
          <h2>No shares from this user</h2>
          <p>This user hasn't shared any articles yet</p>
        {:else if feedFilter}
          <h2>No unread articles</h2>
          <p>You're all caught up on this feed</p>
        {:else}
          <h2>No unread articles</h2>
          <p>You're all caught up! Add more subscriptions to get started</p>
          <a href="/feeds" class="btn btn-primary">Manage Subscriptions</a>
        {/if}
      </div>
    {:else if viewMode === 'shares'}
      <!-- Social shares view -->
      <div class="article-list">
        {#each displayedShares as share, index (share.recordUri)}
          <div bind:this={articleElements[index]}>
            <div
              class="share-item"
              class:selected={selectedIndex === index}
              class:expanded={expandedIndex === index}
            >
              <button class="share-header" onclick={() => {
                if (selectedIndex === index) {
                  selectedIndex = -1;
                  expandedIndex = -1;
                } else {
                  selectItem(index);
                }
              }}>
                {#if share.authorAvatar}
                  <img src={share.authorAvatar} alt="" class="share-avatar" />
                {/if}
                <span class="share-title">{share.itemTitle || share.itemUrl}</span>
                <span class="share-date">{formatDate(share.createdAt)}</span>
              </button>
              {#if selectedIndex === index || expandedIndex === index}
                <div class="share-content">
                  <div class="share-meta">
                    Shared by <strong>{share.authorDisplayName || share.authorHandle}</strong>
                  </div>
                  {#if share.note}
                    <blockquote class="share-note">{share.note}</blockquote>
                  {/if}
                  {#if share.itemDescription}
                    <p class="share-description">{share.itemDescription}</p>
                  {/if}
                  <a href={share.itemUrl} target="_blank" rel="noopener" class="btn btn-secondary">
                    Open Article
                  </a>
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
                article.guid,
                article.url,
                article.title,
                article.author,
                article.summary?.slice(0, 200),
                article.imageUrl
              )}
              onShareWithNote={(note) => sharesStore.shareWithNote(
                sub?.atUri || '',
                article.guid,
                article.url,
                article.title,
                article.author,
                article.summary?.slice(0, 200),
                article.imageUrl,
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

  .loading-state {
    text-align: center;
    padding: 3rem;
    color: var(--color-text-secondary);
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

  .share-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 0.5rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }

  .share-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
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

  .share-date {
    flex-shrink: 0;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
  }

  .share-content {
    padding: 0 0.5rem 1rem;
  }

  .share-meta {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    margin-bottom: 0.75rem;
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

  @media (prefers-color-scheme: dark) {
    .share-item:hover,
    .share-item.selected,
    .share-item.expanded {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
