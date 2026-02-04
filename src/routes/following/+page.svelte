<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores/auth.svelte';
	import { socialStore } from '$lib/stores/social.svelte';
	import { profileService } from '$lib/services/profiles';
	import PageHeader from '$lib/components/common/PageHeader.svelte';
	import StateView from '$lib/components/common/StateView.svelte';
	import UserCard from '$lib/components/common/UserCard.svelte';
	import type { BlueskyProfile, FollowedUserDetailed } from '$lib/types';

	let activeTab = $state<'skyreader' | 'bluesky'>('skyreader');
	let profiles = $state<Map<string, BlueskyProfile>>(new Map());
	let actionInProgress = $state<Set<string>>(new Set());
	let expandedUsers = $state<Set<string>>(new Set());

	function toggleExpanded(did: string) {
		if (expandedUsers.has(did)) {
			expandedUsers.delete(did);
		} else {
			expandedUsers.add(did);
		}
		expandedUsers = new Set(expandedUsers);
	}

	onMount(async () => {
		if (!auth.isAuthenticated) {
			goto('/auth/login?returnUrl=/following');
			return;
		}
		await loadCurrentTab(true);
	});

	async function loadCurrentTab(reset = true) {
		if (activeTab === 'skyreader') {
			await socialStore.loadSkyreaderFollows(reset);
			// Fetch profiles for displayed users
			const dids = socialStore.skyreaderFollows.map((u) => u.did);
			const fetched = await profileService.getProfiles(dids);
			profiles = new Map([...profiles, ...fetched]);
		} else {
			await socialStore.loadBlueskyFollows(reset);
			// Fetch profiles for displayed users
			const dids = socialStore.blueskyFollows.map((u) => u.did);
			const fetched = await profileService.getProfiles(dids);
			profiles = new Map([...profiles, ...fetched]);
		}
	}

	async function switchTab(tab: 'skyreader' | 'bluesky') {
		if (activeTab === tab) return;
		activeTab = tab;
		await loadCurrentTab(true);
	}

	async function loadMore() {
		await loadCurrentTab(false);
	}

	async function handleUnfollow(user: FollowedUserDetailed) {
		if (!user.rkey) return;
		actionInProgress.add(user.did);
		actionInProgress = new Set(actionInProgress);

		const success = await socialStore.unfollowInApp(user.did);
		if (success) {
			// Refresh the list
			await loadCurrentTab();
			// Also refresh the followed users list for sidebar
			await socialStore.loadFollowedUsers();
		}

		actionInProgress.delete(user.did);
		actionInProgress = new Set(actionInProgress);
	}

	async function handleFollow(user: FollowedUserDetailed) {
		actionInProgress.add(user.did);
		actionInProgress = new Set(actionInProgress);

		const success = await socialStore.followUser(user.did);
		if (success) {
			// Refresh both tabs since the user may now appear in both
			await loadCurrentTab();
			// Also refresh the followed users list for sidebar
			await socialStore.loadFollowedUsers();
		}

		actionInProgress.delete(user.did);
		actionInProgress = new Set(actionInProgress);
	}

	function formatRelativeTime(dateString: string | null): string {
		if (!dateString) return 'Never shared';
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) return 'Last shared today';
		if (diffDays === 1) return 'Last shared yesterday';
		if (diffDays < 7) return `Last shared ${diffDays} days ago`;
		if (diffDays < 30) return `Last shared ${Math.floor(diffDays / 7)} weeks ago`;
		if (diffDays < 365) return `Last shared ${Math.floor(diffDays / 30)} months ago`;
		return `Last shared ${Math.floor(diffDays / 365)} years ago`;
	}

	function getProfile(did: string): BlueskyProfile | undefined {
		return profiles.get(did);
	}

	let isLoading = $derived(
		activeTab === 'skyreader'
			? socialStore.isLoadingSkyreaderFollows
			: socialStore.isLoadingBlueskyFollows
	);

	let currentUsers = $derived(
		activeTab === 'skyreader' ? socialStore.skyreaderFollows : socialStore.blueskyFollows
	);

	let hasMore = $derived(
		activeTab === 'skyreader'
			? socialStore.hasMoreSkyreaderFollows
			: socialStore.hasMoreBlueskyFollows
	);
</script>

<div class="following-page">
	<PageHeader title="Following" subtitle="Manage who you follow on Skyreader" />

	{#if socialStore.error}
		<p class="error">{socialStore.error}</p>
	{/if}

	<div class="tabs">
		<button
			class="tab"
			class:active={activeTab === 'skyreader'}
			onclick={() => switchTab('skyreader')}
		>
			Following on Skyreader
		</button>
		<button class="tab" class:active={activeTab === 'bluesky'} onclick={() => switchTab('bluesky')}>
			Following on Bluesky
		</button>
	</div>

	<StateView
		{isLoading}
		isEmpty={currentUsers.length === 0}
		loadingMessage="Loading follows..."
		emptyTitle={activeTab === 'skyreader'
			? 'Not following anyone on Skyreader'
			: 'No Bluesky follows found'}
		emptyDescription={activeTab === 'skyreader'
			? 'Follow users from the Discover page to see their shared articles'
			: 'Sync your Bluesky follows from Settings to see them here'}
		emptyActionHref={activeTab === 'skyreader' ? '/discover' : '/settings'}
		emptyActionText={activeTab === 'skyreader' ? 'Discover Users' : 'Go to Settings'}
	>
		<div class="users-list">
			{#each currentUsers as user (user.did)}
				{@const profile = getProfile(user.did)}
				{@const isExpanded = expandedUsers.has(user.did)}
				{@const hasShares = user.recentShares && user.recentShares.length > 0}
				<div class="user-row card">
					<div class="user-main">
						<div class="user-info">
							<UserCard
								avatarUrl={profile?.avatar}
								displayName={profile?.displayName}
								handle={profile?.handle || user.did}
								size="large"
							/>
							<div class="user-stats">
								<span class="share-count">
									{user.shareCount}
									{user.shareCount === 1 ? 'share' : 'shares'}
								</span>
								<span class="last-shared">{formatRelativeTime(user.lastSharedAt)}</span>
							</div>
						</div>

						<div class="user-actions">
							{#if activeTab === 'skyreader'}
								<button
									class="btn btn-outline unfollow-btn"
									disabled={actionInProgress.has(user.did)}
									onclick={() => handleUnfollow(user)}
								>
									{actionInProgress.has(user.did) ? 'Unfollowing...' : 'Unfollow'}
								</button>
							{:else if user.source === 'both'}
								<span class="already-following">Following on Skyreader</span>
							{:else}
								<button
									class="btn btn-primary follow-btn"
									disabled={actionInProgress.has(user.did)}
									onclick={() => handleFollow(user)}
								>
									{actionInProgress.has(user.did) ? 'Following...' : 'Follow on Skyreader'}
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

					{#if hasShares}
						<button class="disclosure-toggle" onclick={() => toggleExpanded(user.did)}>
							<span class="disclosure-icon">{isExpanded ? '▼' : '▶'}</span>
							<span>Recent shares</span>
						</button>

						{#if isExpanded}
							<ul class="recent-shares">
								{#each user.recentShares! as share}
									<li>
										<a href={share.itemUrl} target="_blank" rel="noopener">
											{share.itemTitle || share.itemUrl}
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</div>
			{/each}
		</div>

		{#if hasMore}
			<div class="load-more">
				<button class="btn btn-secondary" onclick={loadMore} disabled={isLoading}>
					{isLoading ? 'Loading...' : 'Load More'}
				</button>
			</div>
		{/if}
	</StateView>
</div>

<style>
	.following-page {
		max-width: 800px;
		margin: 0 auto;
		padding: 0 1rem;
	}

	.tabs {
		display: flex;
		gap: 0;
		margin: 1rem 0;
		border-bottom: 1px solid var(--color-border);
	}

	.tab {
		background: none;
		border: none;
		padding: 0.75rem 1rem;
		font: inherit;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		transition:
			color 0.15s,
			border-color 0.15s;
	}

	.tab:hover {
		color: var(--color-text);
	}

	.tab.active {
		color: var(--color-primary);
		border-bottom-color: var(--color-primary);
	}

	.users-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

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

	.share-count {
		font-weight: 500;
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

	.recent-shares {
		list-style: none;
		margin: 0;
		padding: 0 0 0 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.recent-shares li {
		font-size: 0.875rem;
	}

	.recent-shares a {
		color: var(--color-text);
		text-decoration: none;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.recent-shares a:hover {
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

	.error {
		color: var(--color-error, #dc3545);
		padding: 1rem;
		background: var(--color-error-bg, #f8d7da);
		border-radius: 8px;
		margin-bottom: 1rem;
	}

	.load-more {
		display: flex;
		justify-content: center;
		padding: 1.5rem 0;
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
