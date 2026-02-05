<script lang="ts">
	import { searchBlueskyActors, type BlueskySearchResult } from '$lib/services/blueskySearch';
	import UserCard from '$lib/components/common/UserCard.svelte';

	interface Props {
		followedDids: Set<string>;
		onFollow: (did: string) => void;
		disabled?: boolean;
	}

	let { followedDids, onFollow, disabled = false }: Props = $props();

	let query = $state('');
	let results = $state<BlueskySearchResult[]>([]);
	let isSearching = $state(false);
	let isOpen = $state(false);
	let selectedIndex = $state(-1);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let containerRef: HTMLDivElement | undefined = $state();
	let inputRef: HTMLInputElement | undefined = $state();

	async function search(searchQuery: string) {
		if (searchQuery.length < 2) {
			results = [];
			isOpen = false;
			return;
		}

		isSearching = true;
		try {
			const searchResults = await searchBlueskyActors(searchQuery, 8);
			results = searchResults;
			isOpen = searchResults.length > 0;
			selectedIndex = -1;
		} catch (error) {
			console.error('Search error:', error);
			results = [];
		} finally {
			isSearching = false;
		}
	}

	function handleInput(event: Event) {
		const target = event.target as HTMLInputElement;
		query = target.value;

		// Clear previous timer
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}

		// Debounce the search
		debounceTimer = setTimeout(() => {
			search(query);
		}, 300);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!isOpen || results.length === 0) {
			return;
		}

		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				selectedIndex = Math.max(selectedIndex - 1, -1);
				break;
			case 'Enter':
				event.preventDefault();
				if (selectedIndex >= 0 && selectedIndex < results.length) {
					selectUser(results[selectedIndex]);
				}
				break;
			case 'Escape':
				event.preventDefault();
				closeDropdown();
				break;
		}
	}

	function selectUser(user: BlueskySearchResult) {
		if (!followedDids.has(user.did)) {
			onFollow(user.did);
		}
		closeDropdown();
	}

	function closeDropdown() {
		isOpen = false;
		selectedIndex = -1;
		query = '';
		results = [];
	}

	function handleClickOutside(event: MouseEvent) {
		if (containerRef && !containerRef.contains(event.target as Node)) {
			closeDropdown();
		}
	}

	function handleFocus() {
		if (results.length > 0) {
			isOpen = true;
		}
	}

	$effect(() => {
		if (isOpen) {
			document.addEventListener('click', handleClickOutside);
			return () => {
				document.removeEventListener('click', handleClickOutside);
			};
		}
	});

	// Clean up timer on unmount
	$effect(() => {
		return () => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
		};
	});
</script>

<div class="user-search" bind:this={containerRef}>
	<div class="search-input-wrapper">
		<input
			bind:this={inputRef}
			type="text"
			class="search-input"
			placeholder="Search for Bluesky users to follow..."
			value={query}
			oninput={handleInput}
			onkeydown={handleKeydown}
			onfocus={handleFocus}
			{disabled}
		/>
		{#if isSearching}
			<div class="search-spinner"></div>
		{/if}
	</div>

	{#if isOpen && results.length > 0}
		<div class="dropdown">
			{#each results as user, index (user.did)}
				{@const isFollowed = followedDids.has(user.did)}
				<button
					class="result-item"
					class:selected={index === selectedIndex}
					class:is-followed={isFollowed}
					onclick={() => selectUser(user)}
					onmouseenter={() => (selectedIndex = index)}
				>
					<UserCard
						avatarUrl={user.avatar}
						displayName={user.displayName}
						handle={user.handle}
						size="medium"
						dimmed={isFollowed}
					>
						{#snippet badge()}
							{#if isFollowed}
								<span class="following-badge">Following</span>
							{/if}
						{/snippet}
					</UserCard>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.user-search {
		position: relative;
		width: 100%;
	}

	.search-input-wrapper {
		position: relative;
	}

	.search-input {
		width: 100%;
		padding: 0.75rem 1rem;
		padding-right: 2.5rem;
		font-size: 1rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-bg);
		color: var(--color-text);
		transition:
			border-color 0.15s,
			box-shadow 0.15s;
	}

	.search-input:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px var(--color-sidebar-active);
	}

	.search-input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.search-input::placeholder {
		color: var(--color-text-secondary);
	}

	.search-spinner {
		position: absolute;
		right: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		width: 1rem;
		height: 1rem;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-primary);
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin {
		to {
			transform: translateY(-50%) rotate(360deg);
		}
	}

	.dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		box-shadow: 0 4px 12px var(--color-shadow, rgba(0, 0, 0, 0.15));
		max-height: 320px;
		overflow-y: auto;
		z-index: 100;
	}

	.result-item {
		display: block;
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		color: var(--color-text);
		font: inherit;
		transition: background-color 0.1s;
	}

	.result-item:first-child {
		border-radius: 7px 7px 0 0;
	}

	.result-item:last-child {
		border-radius: 0 0 7px 7px;
	}

	.result-item:only-child {
		border-radius: 7px;
	}

	.result-item:hover,
	.result-item.selected {
		background: var(--color-bg-secondary);
	}

	.result-item.is-followed {
		cursor: default;
	}

	.following-badge {
		font-size: 0.75rem;
		padding: 0.125rem 0.5rem;
		background: var(--color-sidebar-active);
		color: var(--color-primary);
		border-radius: 9999px;
		font-weight: 500;
	}

	@media (max-width: 600px) {
		.search-input {
			font-size: 16px; /* Prevents iOS zoom on focus */
		}
	}
</style>
