<script lang="ts">
  import type { FollowedUser } from '$lib/stores/social.svelte';
  import { profileService } from '$lib/services/profiles';
  import type { BlueskyProfile } from '$lib/types';
  import Icon from '../Icon.svelte';

  interface Props {
    user: FollowedUser;
    shareCount: number;
    documentCount: number;
    isActive: boolean;
    contentType: 'shares' | 'documents' | null;
    onSelect: () => void;
    onSelectShares: () => void;
    onSelectDocuments: () => void;
    onContextMenu: (e: MouseEvent) => void;
    onTouchStart: (e: TouchEvent) => void;
    onTouchEnd: (e: TouchEvent) => void;
    onTouchMove: () => void;
    onMoreClick: (e: MouseEvent) => void;
  }

  let {
    user,
    shareCount,
    documentCount,
    isActive,
    contentType,
    onSelect,
    onSelectShares,
    onSelectDocuments,
    onContextMenu,
    onTouchStart,
    onTouchEnd,
    onTouchMove,
    onMoreClick,
  }: Props = $props();

  let profile = $state<BlueskyProfile | null>(null);

  $effect(() => {
    profileService.getProfile(user.did).then((p) => {
      profile = p;
    });
  });

  let displayName = $derived(profile?.displayName || profile?.handle || user.did);
  let isInApp = $derived(user.source === 'inapp' || user.source === 'both');
  let totalCount = $derived(shareCount + documentCount);
</script>

<div class="user-item-wrapper">
  <button
    class="nav-item"
    class:active={isActive && contentType === null}
    class:not-on-app={!isInApp}
    onclick={onSelect}
    oncontextmenu={onContextMenu}
    ontouchstart={onTouchStart}
    ontouchend={onTouchEnd}
    ontouchmove={onTouchMove}
  >
    {#if profile?.avatar}
      <img src={profile.avatar} alt="" class="small-avatar" />
    {:else}
      <div class="small-avatar-placeholder"></div>
    {/if}
    <span class="nav-label">{displayName}</span>
    <span
      class="more-btn"
      role="button"
      tabindex="0"
      onclick={(e) => {
        e.stopPropagation();
        onMoreClick(e);
      }}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onMoreClick(e as unknown as MouseEvent);
        }
      }}
      title="More options"
    >
      <Icon name="more-horizontal" size={14} />
    </span>
    {#if totalCount > 0}
      <span class="nav-count">{totalCount}</span>
    {/if}
  </button>

  <button
    class="sub-item"
    class:active={isActive && contentType === 'shares'}
    onclick={onSelectShares}
  >
    <span class="sub-item-icon-wrapper"><Icon name="share" size={14} /></span>
    <span class="nav-label">Shares</span>
    {#if shareCount > 0}
      <span class="nav-count">{shareCount}</span>
    {/if}
  </button>
  <button
    class="sub-item"
    class:active={isActive && contentType === 'documents'}
    onclick={onSelectDocuments}
  >
    <span class="sub-item-icon-wrapper"><Icon name="newspaper" size={14} /></span>
    <span class="nav-label">Articles</span>
    {#if documentCount > 0}
      <span class="nav-count">{documentCount}</span>
    {/if}
  </button>
</div>

<style>
  .user-item-wrapper {
    display: flex;
    flex-direction: column;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    padding-left: 0.75rem;
    background: none;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--color-text);
    transition: background-color 0.15s;
  }

  .nav-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
  }

  .nav-item.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .nav-item.not-on-app {
    opacity: 0.5;
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.875rem;
  }

  .nav-count {
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--color-text-secondary);
  }

  .nav-item.active .nav-count,
  .sub-item.active .nav-count {
    color: var(--color-primary);
  }

  .more-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--color-text-secondary);
    font-size: 1rem;
    padding: 0;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.15s;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .nav-item:hover .more-btn,
  .more-btn:focus {
    opacity: 1;
  }

  .more-btn:hover {
    color: var(--color-text);
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.1));
    border-radius: 4px;
  }

  .small-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .small-avatar-placeholder {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--color-border);
    flex-shrink: 0;
  }

  .sub-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.4rem 0.75rem;
    padding-left: 1.5rem;
    background: none;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-size: 0.8125rem;
    color: var(--color-text-secondary);
    transition: background-color 0.15s;
  }

  .sub-item:hover {
    background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
    color: var(--color-text);
  }

  .sub-item.active {
    background-color: var(--color-sidebar-active, rgba(0, 102, 204, 0.1));
    color: var(--color-primary);
  }

  .sub-item-icon-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  @media (prefers-color-scheme: dark) {
    .nav-item:hover,
    .sub-item:hover {
      background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
    }
  }
</style>
