<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { preferences } from '$lib/stores/preferences.svelte';
	import { feedViewStore } from '$lib/stores/feedView.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { socialStore } from '$lib/stores/social.svelte';

	interface Props {
		showFeedFilter: boolean;
		showAccountFilter: boolean;
	}

	let { showFeedFilter, showAccountFilter }: Props = $props();

	let ef = $derived(feedViewStore.effectiveFilters);

	// Popover open/close state
	let feedPopoverOpen = $state(false);
	let accountPopoverOpen = $state(false);
	let feedPopoverRef: HTMLDivElement | null = $state(null);
	let accountPopoverRef: HTMLDivElement | null = $state(null);

	function setFeedMode(mode: 'none' | 'all' | 'include' | 'exclude') {
		feedViewStore.setToolbarFeedFilter(
			mode,
			mode === 'all' || mode === 'none' ? [] : [...ef.feedIds]
		);
	}

	function toggleFeedId(id: number) {
		const ids = ef.feedIds.includes(id) ? ef.feedIds.filter((f) => f !== id) : [...ef.feedIds, id];
		feedViewStore.setToolbarFeedFilter(ef.feedMode, ids);
	}

	function setAccountMode(mode: 'none' | 'all' | 'include' | 'exclude') {
		feedViewStore.setToolbarAccountFilter(
			mode,
			mode === 'all' || mode === 'none' ? [] : [...ef.accountDids]
		);
	}

	function toggleShares() {
		feedViewStore.setToolbarAccountFilter(
			ef.accountMode,
			[...ef.accountDids],
			!ef.showShares,
			ef.showDocuments
		);
	}

	function toggleDocuments() {
		feedViewStore.setToolbarAccountFilter(
			ef.accountMode,
			[...ef.accountDids],
			ef.showShares,
			!ef.showDocuments
		);
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
		if (ef.feedMode === 'none') return 'Feeds (off)';
		if (ef.feedMode === 'all') return 'Feeds';
		const count = ef.feedIds.length;
		if (ef.feedMode === 'include') return `Feeds (${count})`;
		return `Feeds -${count}`;
	});

	let accountFilterLabel = $derived.by(() => {
		if (ef.accountMode === 'none') return 'Accounts (off)';
		if (ef.accountMode === 'all') return 'Accounts';
		const count = ef.accountDids.length;
		if (ef.accountMode === 'include') return `Accounts (${count})`;
		return `Accounts -${count}`;
	});
</script>

<div class="filter-toolbar" role="toolbar" aria-label="Filter controls">
	<!-- Group 1: Sort + Read state -->
	<div class="filter-group">
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

	{#if showFeedFilter || showAccountFilter}
		<span class="toolbar-divider group-divider"></span>

		<!-- Group 3: Feeds + Accounts dropdowns -->
		<div class="filter-group">
			{#if showFeedFilter}
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
										value="none"
										checked={ef.feedMode === 'none'}
										onchange={() => setFeedMode('none')}
									/>
									None
								</label>
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

							{#if ef.feedMode === 'include' || ef.feedMode === 'exclude'}
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
										value="none"
										checked={ef.accountMode === 'none'}
										onchange={() => setAccountMode('none')}
									/>
									None
								</label>
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

							{#if ef.accountMode !== 'none'}
								<div class="popover-section">
									<label class="check-label">
										<input
											type="checkbox"
											checked={ef.showShares}
											onchange={() => toggleShares()}
										/>
										<span class="check-text">Shares</span>
									</label>
									<label class="check-label">
										<input
											type="checkbox"
											checked={ef.showDocuments}
											onchange={() => toggleDocuments()}
										/>
										<span class="check-text">Articles</span>
									</label>
								</div>
							{/if}

							{#if ef.accountMode === 'include' || ef.accountMode === 'exclude'}
								<div class="popover-list">
									{#each socialStore.inAppFollows as follow}
										<label class="check-label">
											<input
												type="checkbox"
												checked={ef.accountDids.includes(follow.did)}
												onchange={() => toggleAccountDid(follow.did)}
											/>
											<span class="check-text"
												>{follow.displayName || follow.handle || follow.did}</span
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
	{/if}
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
	}

	/* Dark mode + mobile border color */
	@media (prefers-color-scheme: dark) and (max-width: 640px) {
		.filter-group + .group-divider + .filter-group,
		.filter-group:not(:first-child) {
			border-top-color: rgba(255, 255, 255, 0.15);
		}
	}
</style>
