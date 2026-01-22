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
	import { api } from '$lib/services/api';
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

	// Leaflet sync state
	let leafletEnabled = $state(false);
	let leafletLastSynced = $state<number | null>(null);
	let leafletLoading = $state(true);
	let leafletSyncing = $state(false);
	let leafletSyncProgress = $state<{ stage: string; current: number; total: number } | null>(null);
	let leafletSyncResult = $state<{ added: number; skipped: number; errors: string[] } | null>(null);

	function formatRelativeTime(timestamp: number): string {
		const now = Date.now();
		const diff = now - timestamp;
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);

		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
		if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
		return `${days} day${days === 1 ? '' : 's'} ago`;
	}

	async function loadLeafletSettings() {
		try {
			const settings = await api.getLeafletSettings();
			leafletEnabled = settings.enabled;
			leafletLastSynced = settings.lastSyncedAt;
		} catch (error) {
			console.error('Failed to load Leaflet settings:', error);
		} finally {
			leafletLoading = false;
		}
	}

	async function handleLeafletToggle(enabled: boolean) {
		leafletLoading = true;
		try {
			await api.updateLeafletSettings({ enabled });
			leafletEnabled = enabled;
			// If enabling, trigger immediate sync
			if (enabled) {
				await handleLeafletSync();
			}
		} catch (error) {
			console.error('Failed to update Leaflet settings:', error);
		} finally {
			leafletLoading = false;
		}
	}

	async function handleLeafletSync() {
		leafletSyncing = true;
		leafletSyncResult = null;
		leafletSyncProgress = null;
		try {
			// Use the store's syncLeaflet with progress callback
			const result = await subscriptionsStore.syncLeaflet((stage, current, total) => {
				leafletSyncProgress = { stage, current, total };
			});
			leafletSyncResult = result;
			const now = Date.now();
			leafletLastSynced = now;
			// Persist the sync timestamp to the backend
			await api.updateLeafletSettings({ lastSyncedAt: now });
		} catch (error) {
			console.error('Leaflet sync failed:', error);
			const errorMessage = error instanceof Error ? error.message : 'Sync failed';
			leafletSyncResult = { added: 0, skipped: 0, errors: [errorMessage] };
		} finally {
			leafletSyncing = false;
			leafletSyncProgress = null;
		}
	}

	onMount(async () => {
		if (!auth.isAuthenticated) {
			goto('/auth/login?returnUrl=/settings');
			return;
		}
		// Load subscriptions if not already loaded
		if (subscriptionsStore.subscriptions.length === 0) {
			await subscriptionsStore.load();
		}
		// Load Leaflet settings
		await loadLeafletSettings();
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

	<section class="card experimental-section">
		<h2>Experimental</h2>
		<p class="experimental-notice">
			These features are still in development and may not work perfectly.
		</p>
		<div class="integration-item">
			<div class="integration-header">
				<div class="integration-info">
					<h3>Leaflet Sync</h3>
					<p class="setting-description">
						Automatically sync your <a href="https://leaflet.pub" target="_blank" rel="noopener"
							>Leaflet</a
						> subscriptions as RSS feeds in Skyreader.
					</p>
				</div>
				<label class="toggle-setting">
					<input
						type="checkbox"
						checked={leafletEnabled}
						onchange={(e) => handleLeafletToggle(e.currentTarget.checked)}
						disabled={leafletLoading || leafletSyncing}
					/>
					<span class="toggle-label">Enable</span>
				</label>
			</div>

			{#if leafletEnabled}
				<div class="sync-status">
					{#if leafletLastSynced && !leafletSyncing}
						<p class="setting-description">Last synced: {formatRelativeTime(leafletLastSynced)}</p>
					{/if}
					{#if leafletSyncProgress}
						<p class="setting-description">
							{leafletSyncProgress.stage}
							{#if leafletSyncProgress.total > 0}
								({leafletSyncProgress.current}/{leafletSyncProgress.total})
							{/if}
						</p>
					{/if}
					<button
						class="btn btn-secondary"
						onclick={handleLeafletSync}
						disabled={leafletSyncing || leafletLoading}
					>
						{leafletSyncing ? 'Syncing...' : 'Sync Now'}
					</button>
				</div>

				{#if leafletSyncResult && !leafletSyncing}
					<div class="sync-result" class:has-errors={leafletSyncResult.errors.length > 0}>
						{#if leafletSyncResult.added > 0 || leafletSyncResult.skipped > 0}
							<p>
								{#if leafletSyncResult.added > 0}Added {leafletSyncResult.added} feed{leafletSyncResult.added ===
									1
										? ''
										: 's'}.{/if}
								{#if leafletSyncResult.skipped > 0}Skipped {leafletSyncResult.skipped} (already imported).{/if}
							</p>
						{:else if leafletSyncResult.errors.length === 0}
							<p>No Leaflet subscriptions found.</p>
						{/if}
						{#if leafletSyncResult.errors.length > 0}
							<p class="sync-errors">
								{leafletSyncResult.errors.length} error{leafletSyncResult.errors.length === 1
									? ''
									: 's'}: {leafletSyncResult.errors[0]}
							</p>
						{/if}
					</div>
				{/if}
			{/if}
		</div>
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

	.setting-description a {
		color: var(--color-primary);
		text-decoration: none;
	}

	.setting-description a:hover {
		text-decoration: underline;
	}

	.integration-item {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.integration-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}

	.integration-info {
		flex: 1;
	}

	.integration-info h3 {
		font-size: 1rem;
		font-weight: 600;
		margin: 0 0 0.25rem 0;
	}

	.integration-info .setting-description {
		margin: 0;
	}

	.toggle-label {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.sync-status {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem;
		background: var(--color-bg-secondary);
		border-radius: 6px;
	}

	.sync-status .setting-description {
		margin: 0;
		flex: 1;
	}

	.sync-result {
		padding: 0.75rem;
		background: var(--color-bg-secondary);
		border-radius: 6px;
		font-size: 0.875rem;
	}

	.sync-result p {
		margin: 0;
	}

	.sync-result.has-errors {
		background: rgba(239, 68, 68, 0.1);
	}

	.sync-errors {
		color: var(--color-error, #ef4444);
	}

	.experimental-section {
		border: 1px dashed var(--color-border);
		background: repeating-linear-gradient(
			-45deg,
			transparent,
			transparent 10px,
			rgba(128, 128, 128, 0.03) 10px,
			rgba(128, 128, 128, 0.03) 20px
		);
	}

	.experimental-notice {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		font-style: italic;
		margin: 0 0 1rem 0;
		padding: 0.5rem 0.75rem;
		background: rgba(251, 191, 36, 0.1);
		border-radius: 4px;
		border-left: 3px solid rgb(251, 191, 36);
	}
</style>
