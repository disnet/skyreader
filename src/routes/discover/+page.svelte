<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores/auth.svelte';
	import { socialStore } from '$lib/stores/social.svelte';
	import PageHeader from '$lib/components/common/PageHeader.svelte';
	import StateView from '$lib/components/common/StateView.svelte';
	import UserCard from '$lib/components/common/UserCard.svelte';

	let followingDids = $state<Set<string>>(new Set());

	onMount(async () => {
		if (!auth.isAuthenticated) {
			goto('/auth/login?returnUrl=/discover');
			return;
		}
		await Promise.all([socialStore.loadDiscoverUsers(), socialStore.loadFollowedUsers()]);
	});

	async function shuffle() {
		await socialStore.loadDiscoverUsers();
	}

	async function handleFollow(did: string) {
		followingDids.add(did);
		followingDids = new Set(followingDids);
		const success = await socialStore.followUser(did);
		if (!success) {
			followingDids.delete(did);
			followingDids = new Set(followingDids);
		}
	}

	function isFollowing(did: string): boolean {
		return followingDids.has(did) || socialStore.followedUsers.some((u) => u.did === did);
	}
</script>

<div class="discover-page">
	<PageHeader title="Discover" subtitle="Find active Skyreader users to follow">
		<button class="btn btn-secondary" onclick={shuffle} disabled={socialStore.isDiscoverLoading}>
			{socialStore.isDiscoverLoading ? 'Loading...' : 'Shuffle'}
		</button>
	</PageHeader>

	{#if socialStore.error}
		<p class="error">{socialStore.error}</p>
	{/if}

	<StateView
		isLoading={socialStore.isDiscoverLoading && socialStore.discoverUsers.length === 0}
		isEmpty={socialStore.discoverUsers.length === 0}
		loadingMessage="Finding active users..."
		emptyTitle="No users to discover"
		emptyDescription="Check back later when more users have shared articles"
	>
		<div class="users-grid">
			{#each socialStore.discoverUsers as user (user.did)}
				<div class="user-card card">
					<UserCard
						avatarUrl={user.avatarUrl}
						displayName={user.displayName}
						handle={user.handle}
						size="large"
					/>
					<div class="user-stats">
						{user.shareCount}
						{user.shareCount === 1 ? 'share' : 'shares'} in last 30 days
					</div>
					<div class="follow-buttons">
						<button
							class="btn follow-btn"
							class:btn-primary={!isFollowing(user.did)}
							class:btn-secondary={isFollowing(user.did)}
							disabled={isFollowing(user.did) || followingDids.has(user.did)}
							onclick={() => handleFollow(user.did)}
						>
							{#if isFollowing(user.did)}
								Following on Skyreader
							{:else if followingDids.has(user.did)}
								Following...
							{:else}
								Follow on Skyreader
							{/if}
						</button>
						<a
							href="https://bsky.app/profile/{user.handle}"
							target="_blank"
							rel="noopener"
							class="btn btn-outline bluesky-btn"
						>
							Follow on Bluesky ↗
						</a>
					</div>
				</div>
			{/each}
		</div>
	</StateView>
</div>

<style>
	.discover-page {
		max-width: 800px;
		margin: 0 auto;
		padding: 0 1rem;
	}

	.users-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 1rem;
	}

	.user-card {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.user-stats {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.follow-buttons {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.follow-btn {
		width: 100%;
	}

	.bluesky-btn {
		width: 100%;
		text-align: center;
		text-decoration: none;
		background: transparent;
		color: var(--color-text);
		border: 1px solid var(--color-border);
	}

	.bluesky-btn:hover {
		background: var(--color-bg-secondary);
	}

	.error {
		color: var(--color-error, #dc3545);
		padding: 1rem;
		background: var(--color-error-bg, #f8d7da);
		border-radius: 8px;
		margin-bottom: 1rem;
	}
</style>
