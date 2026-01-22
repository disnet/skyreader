<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/stores/auth.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import {
		preferences,
		type ArticleFont,
		type ArticleFontSize,
	} from '$lib/stores/preferences.svelte';
	import ImportOPMLModal from '$lib/components/ImportOPMLModal.svelte';

	const fontOptions: { value: ArticleFont; label: string }[] = [
		{ value: 'sans-serif', label: 'Sans Serif' },
		{ value: 'serif', label: 'Serif' },
		{ value: 'mono', label: 'Monospace' },
	];

	const fontSizeOptions: { value: ArticleFontSize; label: string }[] = [
		{ value: 'xs', label: 'XS' },
		{ value: 'sm', label: 'S' },
		{ value: 'md', label: 'M' },
		{ value: 'lg', label: 'L' },
		{ value: 'xl', label: 'XL' },
	];

	let showImportModal = $state(false);

	onMount(async () => {
		if (!auth.isAuthenticated) {
			goto('/auth/login?returnUrl=/settings');
			return;
		}
		// Load subscriptions if not already loaded
		if (subscriptionsStore.subscriptions.length === 0) {
			await subscriptionsStore.load();
		}
	});

	async function handleLogout() {
		if (confirm('Are you sure you want to log out?')) {
			await auth.logout();
			goto('/');
		}
	}

	let isUnsubscribingAll = $state(false);

	async function handleUnsubscribeAll() {
		const count = subscriptionsStore.subscriptions.length;
		if (count === 0) return;

		if (
			!confirm(
				`Are you sure you want to unsubscribe from all ${count} feeds? This cannot be undone.`
			)
		) {
			return;
		}

		isUnsubscribingAll = true;
		try {
			await subscriptionsStore.removeAll();
		} finally {
			isUnsubscribingAll = false;
		}
	}
</script>

<div class="settings-page">
	<h1>Settings</h1>

	{#if auth.user}
		<section class="card">
			<h2>Account</h2>
			<div class="user-info">
				{#if auth.user.avatarUrl}
					<img src={auth.user.avatarUrl} alt="" class="avatar" />
				{/if}
				<div>
					<p class="display-name">{auth.user.displayName || auth.user.handle}</p>
					<p class="handle">@{auth.user.handle}</p>
					<p class="did">{auth.user.did}</p>
				</div>
			</div>
			<button class="btn btn-danger" onclick={handleLogout}> Log Out </button>
		</section>
	{/if}

	<section class="card">
		<h2>Appearance</h2>
		<div class="setting-row">
			<label for="article-font">Article Font</label>
			<div class="font-options">
				{#each fontOptions as option}
					<button
						class="font-option"
						class:selected={preferences.articleFont === option.value}
						onclick={() => preferences.setArticleFont(option.value)}
					>
						<span
							class="font-preview"
							style:font-family={option.value === 'mono' ? 'monospace' : option.value}>Aa</span
						>
						<span class="font-label">{option.label}</span>
					</button>
				{/each}
			</div>
		</div>
		<div class="setting-row">
			<label for="article-font-size">Article Font Size</label>
			<div class="font-options">
				{#each fontSizeOptions as option}
					<button
						class="font-size-option"
						class:selected={preferences.articleFontSize === option.value}
						onclick={() => preferences.setArticleFontSize(option.value)}
					>
						<span class="font-size-preview" data-size={option.value}>Aa</span>
						<span class="font-label">{option.label}</span>
					</button>
				{/each}
			</div>
		</div>
	</section>

	<section class="card">
		<h2>Reading</h2>
		<label class="toggle-setting">
			<input
				type="checkbox"
				checked={preferences.scrollToMarkAsRead}
				onchange={(e) => preferences.setScrollToMarkAsRead(e.currentTarget.checked)}
			/>
			<span>Mark articles as read when scrolled past</span>
		</label>
		<p class="setting-description">
			Automatically mark articles as read when you scroll past them in the feed.
		</p>
	</section>

	<section class="card">
		<h2>Import / Export</h2>
		<p>Import feeds from other RSS readers using OPML files.</p>
		<button class="btn btn-secondary" onclick={() => (showImportModal = true)}>
			Import OPML
		</button>
	</section>

	<section class="card">
		<h2>About</h2>
		<p>Skyreader is a decentralized RSS reader built on the AT Protocol.</p>
		<p>
			Your data is stored in your Personal Data Server (PDS), giving you full ownership and
			portability.
		</p>
	</section>

	<section class="card debug-section">
		<h2>Debug</h2>
		<p>Development tools for testing.</p>
		<button
			class="btn btn-danger"
			onclick={handleUnsubscribeAll}
			disabled={isUnsubscribingAll || subscriptionsStore.subscriptions.length === 0}
		>
			{#if isUnsubscribingAll}
				Unsubscribing...
			{:else}
				Unsubscribe from All ({subscriptionsStore.subscriptions.length} feeds)
			{/if}
		</button>
	</section>
</div>

<ImportOPMLModal open={showImportModal} onclose={() => (showImportModal = false)} />

<style>
	.settings-page {
		max-width: 600px;
		margin: 0 auto;
	}

	.settings-page h1 {
		margin-bottom: 1.5rem;
	}

	section {
		margin-bottom: 1.5rem;
	}

	section h2 {
		font-size: 1.125rem;
		margin-bottom: 1rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--color-border);
	}

	.user-info {
		display: flex;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.avatar {
		width: 64px;
		height: 64px;
		border-radius: 50%;
	}

	.display-name {
		font-weight: 600;
	}

	.handle {
		color: var(--color-text-secondary);
	}

	.did {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		word-break: break-all;
	}

	.debug-section {
		border: 1px dashed var(--color-border);
		background: var(--color-bg-secondary);
	}

	.debug-section h2 {
		color: var(--color-text-secondary);
	}

	.setting-row {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.setting-row label {
		font-weight: 500;
		color: var(--color-text-secondary);
		font-size: 0.875rem;
	}

	.font-options {
		display: flex;
		gap: 0.75rem;
	}

	.font-option {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		padding: 0.75rem 1rem;
		background: var(--color-bg);
		border: 2px solid var(--color-border);
		border-radius: 8px;
		cursor: pointer;
		transition:
			border-color 0.15s,
			background-color 0.15s;
	}

	.font-option:hover {
		border-color: var(--color-primary);
	}

	.font-option.selected {
		border-color: var(--color-primary);
		background: var(--color-sidebar-active);
	}

	.font-preview {
		font-size: 1.5rem;
		line-height: 1;
	}

	.font-label {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.font-option.selected .font-label {
		color: var(--color-primary);
	}

	.font-size-option {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		padding: 0.75rem 1rem;
		background: var(--color-bg);
		border: 2px solid var(--color-border);
		border-radius: 8px;
		cursor: pointer;
		transition:
			border-color 0.15s,
			background-color 0.15s;
	}

	.font-size-option:hover {
		border-color: var(--color-primary);
	}

	.font-size-option.selected {
		border-color: var(--color-primary);
		background: var(--color-sidebar-active);
	}

	.font-size-option.selected .font-label {
		color: var(--color-primary);
	}

	.font-size-preview {
		line-height: 1;
	}

	.font-size-preview[data-size='xs'] {
		font-size: 0.875rem;
	}

	.font-size-preview[data-size='sm'] {
		font-size: 1rem;
	}

	.font-size-preview[data-size='md'] {
		font-size: 1.125rem;
	}

	.font-size-preview[data-size='lg'] {
		font-size: 1.25rem;
	}

	.font-size-preview[data-size='xl'] {
		font-size: 1.375rem;
	}

	.toggle-setting {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.toggle-setting input[type='checkbox'] {
		width: 1rem;
		height: 1rem;
		cursor: pointer;
	}

	.setting-description {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		margin: 0.5rem 0 0 0;
	}
</style>
