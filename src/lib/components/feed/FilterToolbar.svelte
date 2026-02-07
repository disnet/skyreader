<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { feedViewStore } from '$lib/stores/feedView.svelte';
	import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { socialStore } from '$lib/stores/social.svelte';
	import { profileService } from '$lib/services/profiles';
	import { getFaviconUrl } from '$lib/utils/favicon';
	import { goto } from '$app/navigation';
	import {
		rssSourceKey,
		sharesSourceKey,
		documentsSourceKey,
		isRssSource,
		getRssSubscriptionId,
		getSourceDid,
		isSharesSource,
		isDocumentsSource,
		ACCOUNT_SOURCE_KINDS,
	} from '$lib/utils/sourceKeys';
	import type { BlueskyProfile } from '$lib/types';

	// Resolved profiles for accounts that only have DIDs
	let resolvedProfiles = $state<Map<string, BlueskyProfile>>(new Map());

	// Resolve profiles when inAppFollows changes
	$effect(() => {
		const follows = socialStore.inAppFollows;
		const needsResolving = follows.filter(
			(f) => !f.displayName && (!f.handle || f.handle === f.did || f.handle.startsWith('did:'))
		);
		if (needsResolving.length > 0) {
			profileService.getProfiles(needsResolving.map((f) => f.did)).then((profiles) => {
				resolvedProfiles = profiles;
			});
		}
	});

	function getAccountDisplayName(follow: {
		did: string;
		handle?: string;
		displayName?: string;
	}): string {
		if (follow.displayName) return follow.displayName;
		if (follow.handle && follow.handle !== follow.did && !follow.handle.startsWith('did:'))
			return follow.handle;
		const resolved = resolvedProfiles.get(follow.did);
		if (resolved) return resolved.displayName || resolved.handle;
		return follow.did;
	}

	function getAccountAvatarUrl(follow: { did: string; avatarUrl?: string }): string | undefined {
		if (follow.avatarUrl) return follow.avatarUrl;
		const resolved = resolvedProfiles.get(follow.did);
		return resolved?.avatar;
	}

	interface Props {
		showSourceFilter: boolean;
	}

	let { showSourceFilter }: Props = $props();

	let ef = $derived(feedViewStore.effectiveFilters);

	// Popover open/close state
	let sourcePopoverOpen = $state(false);
	let sourcePopoverRef: HTMLDivElement | null = $state(null);

	// Derive a Set for quick membership checks
	let sourceKeySet = $derived(new Set(ef.sourceKeys));

	// Search state for filtering lists
	let feedSearch = $state('');
	let accountSearch = $state('');

	// Clear search when popover closes
	$effect(() => {
		if (!sourcePopoverOpen) {
			feedSearch = '';
			accountSearch = '';
		}
	});

	// Filtered subscriptions based on search
	let filteredSubscriptions = $derived(
		feedSearch
			? subscriptionsStore.subscriptions.filter((sub) => {
					const term = feedSearch.toLowerCase();
					return (
						(sub.customTitle || sub.title).toLowerCase().includes(term) ||
						sub.feedUrl.toLowerCase().includes(term)
					);
				})
			: subscriptionsStore.subscriptions
	);

	// Filtered follows based on search
	let filteredFollows = $derived(
		accountSearch
			? socialStore.inAppFollows.filter((follow) => {
					const term = accountSearch.toLowerCase();
					const displayName = getAccountDisplayName(follow).toLowerCase();
					return displayName.includes(term) || follow.did.toLowerCase().includes(term);
				})
			: socialStore.inAppFollows
	);

	function setSourceMode(mode: 'all' | 'include') {
		feedViewStore.setToolbarSourceFilter(mode, mode === 'all' ? [] : [...ef.sourceKeys]);
	}

	function toggleSourceKey(key: string) {
		const keys = sourceKeySet.has(key)
			? ef.sourceKeys.filter((k) => k !== key)
			: [...ef.sourceKeys, key];
		feedViewStore.setToolbarSourceFilter(ef.sourceMode, keys);
	}

	// All possible feed keys
	let allFeedKeys = $derived(
		subscriptionsStore.subscriptions.filter((s) => s.id != null).map((s) => rssSourceKey(s.id!))
	);

	// All possible account keys
	let allAccountKeys = $derived(
		socialStore.inAppFollows.flatMap((f) => ACCOUNT_SOURCE_KINDS.map(({ keyFn }) => keyFn(f.did)))
	);

	let allFeedsSelected = $derived(
		allFeedKeys.length > 0 && allFeedKeys.every((k) => sourceKeySet.has(k))
	);
	let allAccountsSelected = $derived(
		allAccountKeys.length > 0 && allAccountKeys.every((k) => sourceKeySet.has(k))
	);

	function selectAllFeeds() {
		const newKeys = allFeedKeys.filter((k) => !sourceKeySet.has(k));
		if (newKeys.length > 0) {
			feedViewStore.setToolbarSourceFilter(ef.sourceMode, [...ef.sourceKeys, ...newKeys]);
		}
	}

	function deselectAllFeeds() {
		const feedKeySet = new Set(allFeedKeys);
		const keys = ef.sourceKeys.filter((k) => !feedKeySet.has(k));
		feedViewStore.setToolbarSourceFilter(ef.sourceMode, keys);
	}

	function selectAllAccounts() {
		const newKeys = allAccountKeys.filter((k) => !sourceKeySet.has(k));
		if (newKeys.length > 0) {
			feedViewStore.setToolbarSourceFilter(ef.sourceMode, [...ef.sourceKeys, ...newKeys]);
		}
	}

	function deselectAllAccounts() {
		const accountKeySet = new Set(allAccountKeys);
		const keys = ef.sourceKeys.filter((k) => !accountKeySet.has(k));
		feedViewStore.setToolbarSourceFilter(ef.sourceMode, keys);
	}

	function handleClickOutside(e: MouseEvent) {
		if (sourcePopoverOpen && sourcePopoverRef && !sourcePopoverRef.contains(e.target as Node)) {
			sourcePopoverOpen = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			sourcePopoverOpen = false;
		}
	}

	onMount(() => {
		document.addEventListener('click', handleClickOutside);
		document.addEventListener('keydown', handleKeydown);
	});

	onDestroy(() => {
		document.removeEventListener('click', handleClickOutside);
		document.removeEventListener('keydown', handleKeydown);
	});

	let sourceFilterLabel = $derived.by(() => {
		if (ef.sourceMode === 'all') return 'Sources';
		return `Sources (${ef.sourceKeys.length})`;
	});

	// Save view state
	let showNameInput = $state(false);
	let newViewName = $state('');
	let nameInputRef = $state<HTMLInputElement | null>(null);
	let saving = $state(false);

	// Whether we're editing an existing saved view
	let isEditingView = $derived(!!feedViewStore.viewFilter);

	async function handleSave() {
		if (isEditingView) {
			// Update existing view
			feedViewStore.syncToolbarToSavedView();
		} else {
			// Show name input for new view
			showNameInput = true;
			newViewName = '';
			// Focus the input after it renders
			requestAnimationFrame(() => nameInputRef?.focus());
		}
	}

	async function handleCreateView() {
		const name = newViewName.trim();
		if (!name || saving) return;

		saving = true;
		try {
			const id = await filteredViewsStore.create({
				name,
				sourceMode: ef.sourceMode,
				sourceKeys: [...ef.sourceKeys],
				readFilter: feedViewStore.showOnlyUnread ? 'unread' : 'all',
				sortOrder: feedViewStore.currentSortOrder,
			});
			showNameInput = false;
			newViewName = '';
			goto(`/?view=${id}`);
		} finally {
			saving = false;
		}
	}

	function handleNameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleCreateView();
		} else if (e.key === 'Escape') {
			showNameInput = false;
			newViewName = '';
		}
	}

	// Svelte action: reposition popover to stay within viewport
	function viewportAware(node: HTMLElement) {
		const PADDING = 8;

		function reposition() {
			// Reset inline overrides so we measure from default CSS position
			node.style.left = '';
			node.style.right = '';
			node.style.top = '';
			node.style.bottom = '';
			node.style.maxHeight = '';

			const rect = node.getBoundingClientRect();
			const vw = window.innerWidth;
			const vh = window.innerHeight;

			// Horizontal: if overflowing right, anchor to right edge of parent instead
			if (rect.right > vw - PADDING) {
				node.style.left = 'auto';
				node.style.right = '0';
			}
			// If it still overflows left after flipping, pin to left edge of viewport
			const rectAfter = node.getBoundingClientRect();
			if (rectAfter.left < PADDING) {
				node.style.left = '0';
				node.style.right = 'auto';
			}

			// Vertical: constrain max-height so it doesn't overflow bottom
			const topAfterH = node.getBoundingClientRect().top;
			const availableBelow = vh - topAfterH - PADDING;
			if (rect.height > availableBelow && availableBelow > 120) {
				node.style.maxHeight = `${availableBelow}px`;
			} else if (availableBelow < 120) {
				// Not enough room below — flip above the trigger
				node.style.top = 'auto';
				node.style.bottom = 'calc(100% + 4px)';
				// Constrain max-height above too
				const parent = node.offsetParent as HTMLElement | null;
				const parentRect = parent?.getBoundingClientRect();
				const availableAbove = parentRect ? parentRect.top - PADDING : vh / 2;
				if (rect.height > availableAbove) {
					node.style.maxHeight = `${availableAbove}px`;
				}
			}
		}

		requestAnimationFrame(reposition);

		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', reposition, true);

		return {
			destroy() {
				window.removeEventListener('resize', reposition);
				window.removeEventListener('scroll', reposition, true);
			},
		};
	}
</script>

<div class="filter-toolbar" role="toolbar" aria-label="Filter controls">
	<!-- Group 1: Sort + Read state -->
	<div class="filter-group">
		<button
			class="filter-btn"
			onclick={() => feedViewStore.toggleSortOrder()}
			title={feedViewStore.currentSortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
		>
			<Icon
				name={feedViewStore.currentSortOrder === 'newest' ? 'arrow-down' : 'arrow-up'}
				size={16}
			/>
			<span class="filter-label">{feedViewStore.currentSortOrder === 'newest' ? 'New' : 'Old'}</span
			>
		</button>

		<span class="toolbar-divider"></span>

		<div class="segment-group" role="group" aria-label="Read filter">
			<button
				class="segment-btn"
				class:active={feedViewStore.showOnlyUnread}
				onclick={() => feedViewStore.setShowOnlyUnread(true)}
			>
				Unread
			</button>
			<button
				class="segment-btn"
				class:active={!feedViewStore.showOnlyUnread}
				onclick={() => feedViewStore.setShowOnlyUnread(false)}
			>
				All
			</button>
		</div>
	</div>

	{#if showSourceFilter}
		<span class="toolbar-divider group-divider"></span>

		<!-- Group 2: Sources dropdown -->
		<div class="filter-group">
			<div class="dropdown-wrapper" bind:this={sourcePopoverRef}>
				<button
					class="filter-btn"
					class:has-filter={ef.sourceMode !== 'all'}
					onclick={(e) => {
						e.stopPropagation();
						sourcePopoverOpen = !sourcePopoverOpen;
					}}
				>
					<span class="filter-label">{sourceFilterLabel}</span>
					<Icon name="chevron-down" size={12} />
				</button>

				{#if sourcePopoverOpen}
					<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
					<div class="popover" use:viewportAware onclick={(e) => e.stopPropagation()}>
						<div class="popover-section">
							<label class="radio-label">
								<input
									type="radio"
									name="sourceMode"
									value="all"
									checked={ef.sourceMode === 'all'}
									onchange={() => setSourceMode('all')}
								/>
								All sources
							</label>
							<label class="radio-label">
								<input
									type="radio"
									name="sourceMode"
									value="include"
									checked={ef.sourceMode === 'include'}
									onchange={() => setSourceMode('include')}
								/>
								Include only
							</label>
						</div>

						{#if ef.sourceMode === 'include'}
							<!-- Feeds group -->
							{#if subscriptionsStore.subscriptions.length > 0}
								<div class="popover-group-header">
									<span>Feeds</span>
									<button
										class="select-all-btn"
										onclick={allFeedsSelected ? deselectAllFeeds : selectAllFeeds}
									>
										{allFeedsSelected ? 'Deselect all' : 'Select all'}
									</button>
								</div>
								<div class="popover-search">
									<input
										type="text"
										placeholder="Search feeds..."
										bind:value={feedSearch}
										class="search-input"
									/>
								</div>
								<div class="popover-list">
									{#each filteredSubscriptions as sub}
										{#if sub.id != null}
											{@const key = rssSourceKey(sub.id)}
											{@const iconUrl =
												sub.customIconUrl || getFaviconUrl(sub.siteUrl || sub.feedUrl)}
											<label class="check-label">
												<input
													type="checkbox"
													checked={sourceKeySet.has(key)}
													onchange={() => toggleSourceKey(key)}
												/>
												{#if iconUrl}
													<img src={iconUrl} alt="" class="check-icon" />
												{/if}
												<span class="check-text">{sub.customTitle || sub.title}</span>
											</label>
										{/if}
									{/each}
									{#if feedSearch && filteredSubscriptions.length === 0}
										<div class="no-results">No feeds match</div>
									{/if}
								</div>
							{/if}

							<!-- Account groups -->
							{#if socialStore.inAppFollows.length > 0}
								<div class="popover-group-header">
									<span>Accounts</span>
									<button
										class="select-all-btn"
										onclick={allAccountsSelected ? deselectAllAccounts : selectAllAccounts}
									>
										{allAccountsSelected ? 'Deselect all' : 'Select all'}
									</button>
								</div>
								<div class="popover-search">
									<input
										type="text"
										placeholder="Search accounts..."
										bind:value={accountSearch}
										class="search-input"
									/>
								</div>
								{#each filteredFollows as follow}
									{@const avatarUrl = getAccountAvatarUrl(follow)}
									<div class="popover-group-header account-group-header">
										{#if avatarUrl}
											<img src={avatarUrl} alt="" class="group-avatar" />
										{:else}
											<div class="group-avatar-placeholder"></div>
										{/if}
										{getAccountDisplayName(follow)}
									</div>
									<div class="popover-list account-kind-list">
										{#each ACCOUNT_SOURCE_KINDS as { kind, label, keyFn }}
											{@const key = keyFn(follow.did)}
											<label class="check-label">
												<input
													type="checkbox"
													checked={sourceKeySet.has(key)}
													onchange={() => toggleSourceKey(key)}
												/>
												<span class="check-text">{label}</span>
											</label>
										{/each}
									</div>
								{/each}
								{#if accountSearch && filteredFollows.length === 0}
									<div class="no-results">No accounts match</div>
								{/if}
							{/if}
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<span class="toolbar-divider group-divider"></span>

	<!-- Save button -->
	<div class="filter-group">
		{#if showNameInput}
			<div class="save-name-input">
				<input
					type="text"
					bind:this={nameInputRef}
					bind:value={newViewName}
					placeholder="View name..."
					onkeydown={handleNameKeydown}
					class="name-input"
				/>
				<button
					class="filter-btn save-confirm-btn"
					onclick={handleCreateView}
					disabled={!newViewName.trim() || saving}
					title="Create view"
				>
					<Icon name="check" size={16} />
				</button>
			</div>
		{:else}
			<button
				class="filter-btn save-btn"
				class:has-changes={isEditingView && feedViewStore.hasUnsavedChanges}
				onclick={handleSave}
				disabled={isEditingView && !feedViewStore.hasUnsavedChanges}
				title={isEditingView ? 'Update view' : 'Save as view'}
			>
				<Icon name="save" size={16} />
				<span class="filter-label">{isEditingView ? 'Update' : 'Save'}</span>
			</button>
		{/if}
	</div>
</div>

<style>
	.filter-toolbar {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.25rem;
		background: rgba(255, 255, 255, 0.85);
		backdrop-filter: blur(8px);
		border-radius: 999px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
		pointer-events: auto;
	}

	.filter-group {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}

	.toolbar-divider {
		width: 1px;
		height: 1rem;
		background: var(--color-border, #e0e0e0);
		margin: 0 0.25rem;
		opacity: 0.5;
	}

	.filter-btn {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		background: none;
		border: none;
		padding: 0.4rem 0.6rem;
		border-radius: 999px;
		cursor: pointer;
		color: var(--color-text-secondary);
		font-size: 0.8125rem;
		font-weight: 500;
		transition: all 0.2s ease;
	}

	.filter-btn:hover {
		color: var(--color-text);
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.filter-btn.has-filter {
		color: var(--color-primary, #2563eb);
		background: rgba(37, 99, 235, 0.08);
	}

	.filter-label {
		white-space: nowrap;
	}

	/* Segment group (Unread / All) */
	.segment-group {
		display: flex;
		gap: 1px;
		border-radius: 999px;
		overflow: hidden;
	}

	.segment-btn {
		background: none;
		border: none;
		padding: 0.4rem 0.6rem;
		cursor: pointer;
		color: var(--color-text-secondary);
		font-size: 0.8125rem;
		font-weight: 500;
		border-radius: 999px;
		transition: all 0.2s ease;
	}

	.segment-btn.active {
		background: var(--color-bg-secondary, #f5f5f5);
		color: var(--color-text);
	}

	.segment-btn:hover:not(.active) {
		color: var(--color-text);
	}

	/* Dropdown wrapper */
	.dropdown-wrapper {
		position: relative;
	}

	.popover {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		min-width: 200px;
		max-width: 280px;
		background: var(--color-bg, #fff);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
		z-index: 100;
		overflow: hidden;
		max-height: 400px;
		overflow-y: auto;
	}

	.popover-section {
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		border-bottom: 1px solid var(--color-border);
	}

	.popover-group-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.375rem 0.5rem 0.125rem;
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		border-top: 1px solid var(--color-border);
	}

	.select-all-btn {
		background: none;
		border: none;
		padding: 0;
		font-size: 0.625rem;
		font-weight: 500;
		color: var(--color-primary, #2563eb);
		cursor: pointer;
		text-transform: none;
		letter-spacing: normal;
	}

	.select-all-btn:hover {
		text-decoration: underline;
	}

	.account-group-header {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		text-transform: none;
		font-size: 0.75rem;
		letter-spacing: normal;
	}

	.group-avatar {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		border-radius: 50%;
		object-fit: cover;
	}

	.group-avatar-placeholder {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--color-border, #e0e0e0);
	}

	.radio-label,
	.check-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.375rem;
		font-size: 0.8125rem;
		cursor: pointer;
		border-radius: 4px;
	}

	.radio-label:hover,
	.check-label:hover {
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.check-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.check-icon {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		border-radius: 2px;
	}

	.popover-search {
		padding: 0.375rem 0.5rem;
	}

	.search-input {
		width: 100%;
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--color-border, #e0e0e0);
		border-radius: 4px;
		font-size: 0.75rem;
		background: var(--color-bg, #fff);
		color: var(--color-text);
		outline: none;
		box-sizing: border-box;
	}

	.search-input:focus {
		border-color: var(--color-primary, #2563eb);
	}

	.search-input::placeholder {
		color: var(--color-text-secondary, #999);
	}

	.no-results {
		padding: 0.375rem 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-secondary, #999);
		text-align: center;
	}

	.popover-list {
		max-height: 200px;
		overflow-y: auto;
		padding: 0.375rem;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.account-kind-list {
		max-height: none;
		padding: 0.25rem 0.375rem 0.25rem 1.5rem;
	}

	/* Save button */
	.save-btn {
		color: var(--color-text-secondary);
	}

	.save-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.save-btn:disabled:hover {
		background: none;
		color: var(--color-text-secondary);
	}

	.save-btn.has-changes {
		color: var(--color-primary, #2563eb);
	}

	.save-btn.has-changes:hover {
		background: rgba(37, 99, 235, 0.08);
		color: var(--color-primary, #2563eb);
	}

	.save-btn:not(:disabled):not(.has-changes):hover {
		color: var(--color-text);
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.save-name-input {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.name-input {
		width: 120px;
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--color-primary, #2563eb);
		border-radius: 999px;
		font-size: 0.8125rem;
		background: var(--color-bg, #fff);
		color: var(--color-text);
		outline: none;
	}

	.name-input::placeholder {
		color: var(--color-text-secondary, #999);
	}

	.save-confirm-btn {
		color: var(--color-primary, #2563eb);
	}

	.save-confirm-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	/* Tablet: hide labels, keep horizontal */
	@media (max-width: 900px) {
		.filter-label {
			display: none;
		}

		.filter-btn,
		.segment-btn {
			padding: 0.4rem;
		}
	}

	/* Mobile: vertical stacked layout with labels restored */
	@media (max-width: 640px) {
		.filter-toolbar {
			flex-direction: column;
			border-radius: 12px;
			gap: 0;
			padding: 0;
		}

		.filter-group {
			width: 100%;
			justify-content: center;
			padding: 0.375rem 0.25rem;
		}

		.filter-group + .group-divider + .filter-group,
		.filter-group:not(:first-child) {
			border-top: 1px solid var(--color-border, #e0e0e0);
		}

		.group-divider {
			display: none;
		}

		.filter-label {
			display: inline;
		}

		.filter-btn,
		.segment-btn {
			padding: 0.4rem 0.6rem;
		}
	}

	@media (max-width: 480px) {
		.filter-btn,
		.segment-btn {
			padding: 0.5rem;
		}

		.filter-toolbar :global(.icon) {
			width: 20px;
			height: 20px;
		}
	}

	@media (prefers-color-scheme: dark) {
		.filter-toolbar {
			background: rgba(40, 40, 40, 0.95);
		}

		.toolbar-divider {
			background: rgba(255, 255, 255, 0.2);
		}

		.segment-btn.active {
			background: rgba(255, 255, 255, 0.15);
		}

		.filter-btn:hover {
			background: rgba(255, 255, 255, 0.1);
		}

		.filter-btn.has-filter {
			background: rgba(37, 99, 235, 0.2);
		}

		.popover {
			background: var(--color-bg, #1a1a1a);
		}

		.name-input {
			background: var(--color-bg, #1a1a1a);
		}
	}

	/* Dark mode + mobile border color */
	@media (prefers-color-scheme: dark) and (max-width: 640px) {
		.filter-group + .group-divider + .filter-group,
		.filter-group:not(:first-child) {
			border-top-color: rgba(255, 255, 255, 0.15);
		}
	}
</style>
