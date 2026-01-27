<script lang="ts">
	import { profileService } from '$lib/services/profiles';
	import type { BlueskyProfile } from '$lib/types';

	let {
		did,
		size = 'medium',
		variant = 'inline',
	}: {
		did: string;
		size?: 'small' | 'medium' | 'large';
		variant?: 'inline' | 'card';
	} = $props();

	let profile = $state<BlueskyProfile | null>(null);

	$effect(() => {
		profileService.getProfile(did).then((p) => {
			profile = p;
		});
	});

	let avatarSize = $derived(size === 'small' ? 24 : size === 'medium' ? 32 : 40);
	let displayName = $derived(profile?.displayName || profile?.handle || did);
	let handle = $derived(profile?.handle || did);
</script>

{#if variant === 'card'}
	<a href="/?sharer={did}" class="user-card size-{size}">
		{#if profile?.avatar}
			<img
				src={profile.avatar}
				alt=""
				class="avatar"
				style="width: {avatarSize}px; height: {avatarSize}px;"
			/>
		{:else}
			<div class="avatar-placeholder" style="width: {avatarSize}px; height: {avatarSize}px;">
				{handle.charAt(0).toUpperCase()}
			</div>
		{/if}
		<div class="user-info">
			<span class="display-name">{displayName}</span>
			{#if profile?.displayName}
				<span class="handle">@{handle}</span>
			{/if}
		</div>
	</a>
{:else}
	<span class="user-inline">
		{#if profile?.avatar}
			<img
				src={profile.avatar}
				alt=""
				class="avatar-inline"
				style="width: {avatarSize}px; height: {avatarSize}px;"
			/>
		{/if}
		<span class="handle-inline">@{handle}</span>
	</span>
{/if}

<style>
	.user-card {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: 8px;
		text-decoration: none;
		color: inherit;
		transition: background-color 0.15s ease;
	}

	.user-card:hover {
		background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.03));
	}

	.avatar {
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.avatar-placeholder {
		border-radius: 50%;
		background: var(--color-primary);
		color: white;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		flex-shrink: 0;
	}

	.user-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.display-name {
		font-weight: 500;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.handle {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.user-inline {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.avatar-inline {
		border-radius: 50%;
		object-fit: cover;
	}

	.handle-inline {
		color: var(--color-text-secondary);
	}

	@media (prefers-color-scheme: dark) {
		.user-card:hover {
			background-color: var(--color-bg-hover, rgba(255, 255, 255, 0.05));
		}
	}
</style>
