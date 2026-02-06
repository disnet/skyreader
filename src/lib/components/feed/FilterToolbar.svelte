<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { feedViewStore } from '$lib/stores/feedView.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { socialStore } from '$lib/stores/social.svelte';

	interface Props {
		showContentTypeFilter: boolean;
		showFeedFilter: boolean;
		showAccountFilter: boolean;
	}

	let { showContentTypeFilter, showFeedFilter, showAccountFilter }: Props = $props();

	let ef = $derived(feedViewStore.effectiveFilters);

	// Popover open/close state
	let feedPopoverOpen = $state(false);
	let accountPopoverOpen = $state(false);
	let feedPopoverRef: HTMLDivElement | null = $state(null);
	let accountPopoverRef: HTMLDivElement | null = $state(null);

	function setFeedMode(mode: 'all' | 'include' | 'exclude') {
		feedViewStore.setToolbarFeedFilter(mode, mode === 'all' ? [] : ef.feedIds);
	}

	function toggleFeedId(id: number) {
		const ids = ef.feedIds.includes(id) ? ef.feedIds.filter((f) => f !== id) : [...ef.feedIds, id];
		feedViewStore.setToolbarFeedFilter(ef.feedMode, ids);
	}

	function setAccountMode(mode: 'all' | 'include' | 'exclude') {
		feedViewStore.setToolbarAccountFilter(mode, mode === 'all' ? [] : ef.accountDids);
	}

	function toggleAccountDid(did: string) {
		const dids = ef.accountDids.includes(did)
			? ef.accountDids.filter((d) => d !== did)
			: [...ef.accountDids, did];
		feedViewStore.setToolbarAccountFilter(ef.accountMode, dids);
	}

	function handleClickOutside(e: MouseEvent) {
		if (feedPopoverOpen && feedPopoverRef && !feedPopoverRef.contains(e.target as Node)) {
			feedPopoverOpen = false;
		}
		if (accountPopoverOpen && accountPopoverRef && !accountPopoverRef.contains(e.target as Node)) {
			accountPopoverOpen = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			feedPopoverOpen = false;
			accountPopoverOpen = false;
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

	let feedFilterLabel = $derived.by(() => {
		if (ef.feedMode === 'all') return 'Feeds';
		const count = ef.feedIds.length;
		if (ef.feedMode === 'include') return `Feeds (${count})`;
		return `Feeds -${count}`;
	});

	let accountFilterLabel = $derived.by(() => {
		if (ef.accountMode === 'all') return 'Accounts';
		const count = ef.accountDids.length;
		if (ef.accountMode === 'include') return `Accounts (${count})`;
		return `Accounts -${count}`;
	});
</script>

<div class="filter-toolbar" role="toolbar" aria-label="Filter controls">
	<!-- Sort toggle -->
	<button
		class="filter-btn"
		onclick={() => {
			preferences.toggleSortOrder();
			feedViewStore.syncToolbarToSavedView();
		}}
		title={preferences.sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
	>
		<Icon name={preferences.sortOrder === 'newest' ? 'arrow-down' : 'arrow-up'} size={16} />
		<span class="filter-label">{preferences.sortOrder === 'newest' ? 'New' : 'Old'}</span>
	</button>

	<span class="toolbar-divider"></span>

	<!-- Read state toggle -->
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

	{#if showContentTypeFilter}
		<span class="toolbar-divider"></span>

		<!-- Content type chips -->
		<div class="chip-group" role="group" aria-label="Content types">
			<button
				class="chip"
				class:active={ef.showArticles}
				onclick={() =>
					feedViewStore.setToolbarContentTypes(!ef.showArticles, ef.showShares, ef.showDocuments)}
				title="Toggle articles"
			>
				<Icon name="rss" size={16} />
				<span class="chip-label">Articles</span>
			</button>
			<button
				class="chip"
				class:active={ef.showShares}
				onclick={() =>
					feedViewStore.setToolbarContentTypes(ef.showArticles, !ef.showShares, ef.showDocuments)}
				title="Toggle shares"
			>
				<Icon name="share" size={16} />
				<span class="chip-label">Shares</span>
			</button>
			<button
				class="chip"
				class:active={ef.showDocuments}
				onclick={() =>
					feedViewStore.setToolbarContentTypes(ef.showArticles, ef.showShares, !ef.showDocuments)}
				title="Toggle documents"
			>
				<Icon name="file-text" size={16} />
				<span class="chip-label">Docs</span>
			</button>
		</div>
	{/if}

	{#if showFeedFilter}
		<span class="toolbar-divider"></span>

		<!-- Feeds dropdown -->
		<div class="dropdown-wrapper" bind:this={feedPopoverRef}>
			<button
				class="filter-btn"
				class:has-filter={ef.feedMode !== 'all'}
				onclick={(e) => {
					e.stopPropagation();
					feedPopoverOpen = !feedPopoverOpen;
					accountPopoverOpen = false;
				}}
			>
				<span class="filter-label">{feedFilterLabel}</span>
				<Icon name="chevron-down" size={12} />
			</button>

			{#if feedPopoverOpen}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="popover" onclick={(e) => e.stopPropagation()}>
					<div class="popover-section">
						<label class="radio-label">
							<input
								type="radio"
								name="feedMode"
								value="all"
								checked={ef.feedMode === 'all'}
								onchange={() => setFeedMode('all')}
							/>
							All feeds
						</label>
						<label class="radio-label">
							<input
								type="radio"
								name="feedMode"
								value="include"
								checked={ef.feedMode === 'include'}
								onchange={() => setFeedMode('include')}
							/>
							Include only
						</label>
						<label class="radio-label">
							<input
								type="radio"
								name="feedMode"
								value="exclude"
								checked={ef.feedMode === 'exclude'}
								onchange={() => setFeedMode('exclude')}
							/>
							Exclude
						</label>
					</div>

					{#if ef.feedMode !== 'all'}
						<div class="popover-list">
							{#each subscriptionsStore.subscriptions as sub}
								{#if sub.id != null}
									<label class="check-label">
										<input
											type="checkbox"
											checked={ef.feedIds.includes(sub.id)}
											onchange={() => toggleFeedId(sub.id!)}
										/>
										<span class="check-text">{sub.customTitle || sub.title}</span>
									</label>
								{/if}
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	{#if showAccountFilter}
		<span class="toolbar-divider"></span>

		<!-- Accounts dropdown -->
		<div class="dropdown-wrapper" bind:this={accountPopoverRef}>
			<button
				class="filter-btn"
				class:has-filter={ef.accountMode !== 'all'}
				onclick={(e) => {
					e.stopPropagation();
					accountPopoverOpen = !accountPopoverOpen;
					feedPopoverOpen = false;
				}}
			>
				<span class="filter-label">{accountFilterLabel}</span>
				<Icon name="chevron-down" size={12} />
			</button>

			{#if accountPopoverOpen}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div class="popover" onclick={(e) => e.stopPropagation()}>
					<div class="popover-section">
						<label class="radio-label">
							<input
								type="radio"
								name="accountMode"
								value="all"
								checked={ef.accountMode === 'all'}
								onchange={() => setAccountMode('all')}
							/>
							All accounts
						</label>
						<label class="radio-label">
							<input
								type="radio"
								name="accountMode"
								value="include"
								checked={ef.accountMode === 'include'}
								onchange={() => setAccountMode('include')}
							/>
							Include only
						</label>
						<label class="radio-label">
							<input
								type="radio"
								name="accountMode"
								value="exclude"
								checked={ef.accountMode === 'exclude'}
								onchange={() => setAccountMode('exclude')}
							/>
							Exclude
						</label>
					</div>

					{#if ef.accountMode !== 'all'}
						<div class="popover-list">
							{#each socialStore.inAppFollows as follow}
								<label class="check-label">
									<input
										type="checkbox"
										checked={ef.accountDids.includes(follow.did)}
										onchange={() => toggleAccountDid(follow.did)}
									/>
									<span class="check-text">{follow.displayName || follow.handle || follow.did}</span
									>
								</label>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.filter-toolbar {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-wrap: wrap;
		padding: 0.25rem;
		background: rgba(255, 255, 255, 0.85);
		backdrop-filter: blur(8px);
		border-radius: 999px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
		pointer-events: auto;
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

	/* Content type chips */
	.chip-group {
		display: flex;
		gap: 0.125rem;
	}

	.chip {
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
		opacity: 0.5;
	}

	.chip.active {
		opacity: 1;
		color: var(--color-text);
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.chip:hover:not(.active) {
		opacity: 0.8;
	}

	.chip-label {
		white-space: nowrap;
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
	}

	.popover-section {
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		border-bottom: 1px solid var(--color-border);
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

	.popover-list {
		max-height: 200px;
		overflow-y: auto;
		padding: 0.375rem;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	@media (max-width: 900px) {
		.chip-label,
		.filter-label {
			display: none;
		}

		.filter-btn,
		.segment-btn,
		.chip {
			padding: 0.4rem;
		}
	}

	@media (max-width: 640px) {
		.filter-toolbar {
			border-radius: 12px;
		}
	}

	@media (max-width: 480px) {
		.filter-btn,
		.segment-btn,
		.chip {
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

		.segment-btn.active,
		.chip.active {
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
	}
</style>
