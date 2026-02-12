<script lang="ts">
  import UserCard from '$lib/components/common/UserCard.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import logo from '$lib/assets/logo.svg';
  import type { BlueskyProfile, FollowedUserDetailed } from '$lib/types';

  interface Props {
    user: FollowedUserDetailed;
    profile?: BlueskyProfile;
    mode: 'skyreader' | 'bluesky';
    isExpanded: boolean;
    isActionInProgress: boolean;
    onToggleExpanded: () => void;
    onFollow: (user: FollowedUserDetailed) => void;
    onUnfollow: (user: FollowedUserDetailed) => void;
  }

  let {
    user,
    profile,
    mode,
    isExpanded,
    isActionInProgress,
    onToggleExpanded,
    onFollow,
    onUnfollow,
  }: Props = $props();

  function formatRelativeTime(dateString: string | null, prefix: string = 'Last active'): string {
    if (!dateString) return 'No activity';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return `${prefix} today`;
    if (diffDays === 1) return `${prefix} yesterday`;
    if (diffDays < 7) return `${prefix} ${diffDays} days ago`;
    if (diffDays < 30) return `${prefix} ${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${prefix} ${Math.floor(diffDays / 30)} months ago`;
    return `${prefix} ${Math.floor(diffDays / 365)} years ago`;
  }

  function getLastActivityDate(u: FollowedUserDetailed): string | null {
    const dates: number[] = [];
    if (u.lastSharedAt) dates.push(new Date(u.lastSharedAt).getTime());
    if (u.lastPublishedAt) dates.push(new Date(u.lastPublishedAt).getTime());
    if (dates.length === 0) return null;
    return new Date(Math.max(...dates)).toISOString();
  }

  let hasShares = $derived(user.recentShares && user.recentShares.length > 0);
  let hasDocuments = $derived(user.recentDocuments && user.recentDocuments.length > 0);
  let hasContent = $derived(hasShares || hasDocuments);
</script>

<div class="user-row card">
  <div class="user-main">
    <div class="user-info">
      <UserCard
        avatarUrl={profile?.avatar}
        displayName={profile?.displayName}
        handle={profile?.handle || user.did}
        size="large"
      />
      {#if mode === 'skyreader'}
        <div class="user-stats">
          {#if user.shareCount > 0}
            <span class="share-count">
              <img src={logo} alt="" class="stat-icon" />
              {user.shareCount}
              {user.shareCount === 1 ? 'share' : 'shares'}
            </span>
          {/if}
          {#if user.documentCount && user.documentCount > 0}
            <span class="document-count">
              <Icon name="newspaper" size={14} />
              {user.documentCount}
              {user.documentCount === 1 ? 'article' : 'articles'}
            </span>
          {/if}
          {#if getLastActivityDate(user)}
            <span class="last-shared">{formatRelativeTime(getLastActivityDate(user))}</span>
          {/if}
        </div>
      {/if}
    </div>

    <div class="user-actions">
      {#if mode === 'skyreader'}
        <button
          class="btn btn-outline unfollow-btn"
          disabled={isActionInProgress}
          onclick={() => onUnfollow(user)}
        >
          {isActionInProgress ? 'Unfollowing...' : 'Unfollow'}
        </button>
      {:else if user.source === 'both'}
        <span class="already-following">Following on Skyreader</span>
      {:else}
        <button
          class="btn btn-primary follow-btn"
          disabled={isActionInProgress}
          onclick={() => onFollow(user)}
        >
          {isActionInProgress ? 'Following...' : 'Follow on Skyreader'}
        </button>
      {/if}
      <a
        href="https://bsky.app/profile/{profile?.handle || user.did}"
        target="_blank"
        rel="noopener"
        class="btn btn-outline bluesky-link"
      >
        Bluesky Profile
      </a>
    </div>
  </div>

  {#if hasContent}
    <button class="disclosure-toggle" onclick={onToggleExpanded}>
      <span class="disclosure-icon">{isExpanded ? '▼' : '▶'}</span>
      <span>Recent activity</span>
    </button>

    {#if isExpanded}
      {#if hasShares}
        <div class="recent-section">
          <h4 class="recent-section-title">
            <img src={logo} alt="" class="section-icon" />
            Shares
          </h4>
          <ul class="recent-items">
            {#each user.recentShares! as share}
              <li>
                <a href={share.itemUrl} target="_blank" rel="noopener">
                  {share.itemTitle || share.itemUrl}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if hasDocuments}
        <div class="recent-section">
          <h4 class="recent-section-title">
            <Icon name="newspaper" size={12} />
            Articles
          </h4>
          <ul class="recent-items">
            {#each user.recentDocuments! as doc}
              <li>
                <a href={doc.url} target="_blank" rel="noopener">
                  {doc.title || doc.url}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .user-row {
    display: flex;
    flex-direction: column;
    padding: 1rem;
    gap: 0.75rem;
  }

  .user-main {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    width: 100%;
  }

  .user-info {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
    flex: 1;
  }

  .user-stats {
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    padding-left: 3.5rem;
  }

  .share-count,
  .document-count {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-weight: 500;
  }

  .stat-icon {
    width: 14px;
    height: 14px;
  }

  .user-actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .disclosure-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    padding: 0.5rem 0;
    font: inherit;
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: color 0.15s;
  }

  .disclosure-toggle:hover {
    color: var(--color-primary);
  }

  .disclosure-icon {
    font-size: 0.625rem;
    width: 1rem;
  }

  .recent-section {
    margin-top: 0.5rem;
  }

  .recent-section-title {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 0.25rem 1.5rem;
  }

  .section-icon {
    width: 12px;
    height: 12px;
  }

  .recent-items {
    list-style: none;
    margin: 0;
    padding: 0 0 0 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .recent-items li {
    font-size: 0.875rem;
  }

  .recent-items a {
    color: var(--color-text);
    text-decoration: none;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-items a:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .follow-btn,
  .unfollow-btn {
    min-width: 150px;
  }

  .bluesky-link {
    text-align: center;
    text-decoration: none;
    font-size: 0.875rem;
  }

  .already-following {
    font-size: 0.875rem;
    color: var(--color-text-secondary);
    padding: 0.5rem;
    text-align: center;
  }

  @media (max-width: 600px) {
    .user-main {
      flex-direction: column;
      align-items: stretch;
    }

    .user-stats {
      padding-left: 0;
    }

    .user-actions {
      flex-direction: row;
      flex-wrap: wrap;
    }

    .follow-btn,
    .unfollow-btn,
    .bluesky-link {
      flex: 1;
      min-width: 120px;
    }
  }
</style>
