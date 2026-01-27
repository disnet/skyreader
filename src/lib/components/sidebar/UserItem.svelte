<script lang="ts">
	import type { FollowedUser } from '$lib/stores/social.svelte';
	import { profileService } from '$lib/services/profiles';
	import type { BlueskyProfile } from '$lib/types';

	interface Props {
		user: FollowedUser;
		unreadCount: number;
		isActive: boolean;
		onSelect: () => void;
	}

	let { user, unreadCount, isActive, onSelect }: Props = $props();

	let profile = $state<BlueskyProfile | null>(null);

	$effect(() => {
		profileService.getProfile(user.did).then((p) => {
			profile = p;
		});
	});

	let displayName = $derived(profile?.displayName || profile?.handle || user.did);
	let isInApp = $derived(user.source === 'inapp' || user.source === 'both');
</script>

<button
	class="nav-item sub-item"
	class:active={isActive}
	class:not-on-app={!isInApp}
	onclick={onSelect}
>
	{#if profile?.avatar}
		<img src={profile.avatar} alt="" class="small-avatar" />
	{:else}
		<div class="small-avatar-placeholder"></div>
	{/if}
	<span class="nav-label">{displayName}</span>
	{#if unreadCount > 0}
		<span class="nav-count">{unreadCount}</span>
	{/if}
</button>

<style>
	.nav-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: none;
		border: none;
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

	.nav-item.sub-item {
		padding-left: 1.5rem;
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

	.nav-item.active .nav-count {
		color: var(--color-primary);
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

	@media (prefers-color-scheme: dark) {
		.nav-item:hover {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}
	}
</style>
