<script lang="ts">
	import { parseOPMLFile, type OPMLFeed } from '$lib/utils/opml-parser';
	import { subscriptionsStore, MAX_SUBSCRIPTIONS } from '$lib/stores/subscriptions.svelte';
	import Modal from '$lib/components/common/Modal.svelte';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();

	type ModalState = 'select' | 'preview' | 'importing' | 'complete';
	let modalState: ModalState = $state('select');
	let parsedFeeds: OPMLFeed[] = $state([]);
	let parseErrors: string[] = $state([]);
	let selectedUrls: Set<string> = $state(new Set());
	let existingUrls: Set<string> = $state(new Set());
	let progress = $state({ current: 0, total: 0 });
	let results = $state({ added: 0, skipped: 0, failed: [] as string[], truncated: 0 });
	let fileInput: HTMLInputElement | undefined = $state();

	const availableSlots = $derived(MAX_SUBSCRIPTIONS - subscriptionsStore.subscriptions.length);
	const selectedNonDuplicates = $derived(
		[...selectedUrls].filter((url) => !existingUrls.has(url.toLowerCase())).length
	);
	const willExceedLimit = $derived(selectedNonDuplicates > availableSlots);

	function reset() {
		modalState = 'select';
		parsedFeeds = [];
		parseErrors = [];
		selectedUrls = new Set();
		existingUrls = new Set();
		progress = { current: 0, total: 0 };
		results = { added: 0, skipped: 0, failed: [], truncated: 0 };
		if (fileInput) fileInput.value = '';
	}

	function handleClose() {
		reset();
		onclose();
	}

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const result = await parseOPMLFile(file);
		parsedFeeds = result.feeds;
		parseErrors = result.errors;

		if (parsedFeeds.length === 0) {
			return;
		}

		// Check which feeds already exist
		const existing = new Set(subscriptionsStore.subscriptions.map((s) => s.feedUrl.toLowerCase()));
		existingUrls = existing;

		// Pre-select only non-duplicate feeds
		selectedUrls = new Set(
			parsedFeeds.filter((f) => !existing.has(f.feedUrl.toLowerCase())).map((f) => f.feedUrl)
		);

		modalState = 'preview';
	}

	function toggleFeed(feedUrl: string) {
		const newSet = new Set(selectedUrls);
		if (newSet.has(feedUrl)) {
			newSet.delete(feedUrl);
		} else {
			newSet.add(feedUrl);
		}
		selectedUrls = newSet;
	}

	function selectAll() {
		selectedUrls = new Set(parsedFeeds.map((f) => f.feedUrl));
	}

	function selectNone() {
		selectedUrls = new Set();
	}

	async function startImport() {
		const feedsToImport = parsedFeeds.filter((f) => selectedUrls.has(f.feedUrl));
		if (feedsToImport.length === 0) return;

		modalState = 'importing';
		progress = { current: 0, total: feedsToImport.length };

		const result = await subscriptionsStore.addBulk(feedsToImport, (current, total) => {
			progress = { current, total };
		});

		results = {
			added: result.added.length,
			skipped: result.skipped.length,
			failed: result.failed.map((f) => f.url),
			truncated: result.truncated,
		};

		modalState = 'complete';

		// Check which feeds are already cached on the backend (from other users)
		// and start fetching them immediately
		if (result.added.length > 0) {
			const newFeedUrls = feedsToImport.map((f) => f.feedUrl);

			// Check backend status - feeds already cached will be marked 'ready'
			await subscriptionsStore.checkFeedStatuses(newFeedUrls);

			// Fetch ready feeds from cache immediately, then pending feeds gradually
			subscriptionsStore.fetchAllNewFeeds();
		}
	}

	function isDuplicate(feedUrl: string): boolean {
		return existingUrls.has(feedUrl.toLowerCase());
	}

	$effect(() => {
		if (!open) {
			reset();
		}
	});
</script>

<Modal {open} onclose={handleClose} title="Import OPML" maxWidth="520px">
	{#if modalState === 'select'}
		<p class="description">Select an OPML file to import feeds from another RSS reader.</p>
		<input
			bind:this={fileInput}
			type="file"
			accept=".opml,.xml"
			onchange={handleFileSelect}
			class="file-input"
		/>
		{#if parseErrors.length > 0}
			<div class="error-list">
				{#each parseErrors as error}
					<p class="error">{error}</p>
				{/each}
			</div>
		{/if}
	{:else if modalState === 'preview'}
		<div class="preview-header">
			<p>Found {parsedFeeds.length} feed{parsedFeeds.length === 1 ? '' : 's'}</p>
			<div class="selection-actions">
				<button class="link-btn" onclick={selectAll}>Select all</button>
				<button class="link-btn" onclick={selectNone}>Select none</button>
			</div>
		</div>
		{#if willExceedLimit}
			<div class="limit-warning">
				You can only add {availableSlots} more feed{availableSlots === 1 ? '' : 's'} (limit: {MAX_SUBSCRIPTIONS}).
				{#if availableSlots > 0}
					The first {availableSlots} will be imported.
				{:else}
					Remove some existing feeds to import new ones.
				{/if}
			</div>
		{/if}
		<ul class="feed-list">
			{#each parsedFeeds as feed}
				{@const duplicate = isDuplicate(feed.feedUrl)}
				<li class="feed-item" class:duplicate>
					<label>
						<input
							type="checkbox"
							checked={selectedUrls.has(feed.feedUrl)}
							onchange={() => toggleFeed(feed.feedUrl)}
						/>
						<span class="feed-info">
							<span class="feed-title">{feed.title}</span>
							{#if feed.category}
								<span class="feed-category">{feed.category}</span>
							{/if}
							{#if duplicate}
								<span class="duplicate-badge">Already subscribed</span>
							{/if}
						</span>
					</label>
				</li>
			{/each}
		</ul>
		{#if parseErrors.length > 0}
			<details class="parse-errors">
				<summary>{parseErrors.length} warning{parseErrors.length === 1 ? '' : 's'}</summary>
				<ul>
					{#each parseErrors as error}
						<li>{error}</li>
					{/each}
				</ul>
			</details>
		{/if}
	{:else if modalState === 'importing'}
		<p>Importing feeds...</p>
		<div class="progress-bar">
			<div class="progress-fill" style="width: {(progress.current / progress.total) * 100}%"></div>
		</div>
		<p class="progress-text">{progress.current} / {progress.total}</p>
	{:else if modalState === 'complete'}
		<h3>Import Complete</h3>
		<dl class="results">
			<dt>Added</dt>
			<dd>{results.added}</dd>
			{#if results.skipped > 0}
				<dt>Skipped (duplicates)</dt>
				<dd>{results.skipped}</dd>
			{/if}
			{#if results.truncated > 0}
				<dt>Not imported (limit reached)</dt>
				<dd>{results.truncated}</dd>
			{/if}
			{#if results.failed.length > 0}
				<dt>Failed</dt>
				<dd>{results.failed.length}</dd>
			{/if}
		</dl>
		{#if results.failed.length > 0}
			<details class="failed-list">
				<summary>View failed imports</summary>
				<ul>
					{#each results.failed as url}
						<li>{url}</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}

	{#snippet footer()}
		{#if modalState === 'preview'}
			<button
				class="btn btn-secondary"
				onclick={() => {
					modalState = 'select';
				}}
			>
				Back
			</button>
			<button class="btn btn-primary" onclick={startImport} disabled={selectedUrls.size === 0}>
				Import {selectedUrls.size} feed{selectedUrls.size === 1 ? '' : 's'}
			</button>
		{:else if modalState === 'complete'}
			<button class="btn btn-primary" onclick={handleClose}> Done </button>
		{/if}
	{/snippet}
</Modal>

<style>
	.description {
		color: var(--color-text-secondary);
		margin-bottom: 1rem;
	}

	.file-input {
		width: 100%;
		padding: 0.75rem;
		border: 2px dashed var(--color-border);
		border-radius: 4px;
		cursor: pointer;
	}

	.file-input:hover {
		border-color: var(--color-primary);
	}

	.error-list {
		margin-top: 1rem;
	}

	.error {
		color: var(--color-error);
		font-size: 0.875rem;
	}

	.preview-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.limit-warning {
		background: var(--color-warning-bg, #fef3c7);
		color: var(--color-warning-text, #92400e);
		padding: 0.75rem;
		border-radius: 4px;
		font-size: 0.875rem;
		margin-bottom: 1rem;
	}

	.selection-actions {
		display: flex;
		gap: 1rem;
	}

	.link-btn {
		background: none;
		border: none;
		color: var(--color-primary);
		cursor: pointer;
		font-size: 0.875rem;
		padding: 0;
	}

	.link-btn:hover {
		text-decoration: underline;
	}

	.feed-list {
		list-style: none;
		padding: 0;
		margin: 0;
		max-height: 300px;
		overflow-y: auto;
		border: 1px solid var(--color-border);
		border-radius: 4px;
	}

	.feed-item {
		border-bottom: 1px solid var(--color-border);
	}

	.feed-item:last-child {
		border-bottom: none;
	}

	.feed-item label {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem;
		cursor: pointer;
	}

	.feed-item:hover {
		background: var(--color-bg-secondary);
	}

	.feed-item.duplicate {
		opacity: 0.7;
	}

	.feed-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.feed-title {
		font-weight: 500;
		word-break: break-word;
	}

	.feed-category {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.duplicate-badge {
		font-size: 0.75rem;
		color: var(--color-warning, #b45309);
		font-style: italic;
	}

	.parse-errors {
		margin-top: 1rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.parse-errors ul {
		margin-top: 0.5rem;
		padding-left: 1.5rem;
	}

	.progress-bar {
		height: 8px;
		background: var(--color-border);
		border-radius: 4px;
		overflow: hidden;
		margin: 1rem 0;
	}

	.progress-fill {
		height: 100%;
		background: var(--color-primary);
		transition: width 0.2s ease;
	}

	.progress-text {
		text-align: center;
		color: var(--color-text-secondary);
		font-size: 0.875rem;
	}

	h3 {
		margin-top: 0;
		margin-bottom: 1rem;
	}

	.results {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.5rem 1rem;
	}

	.results dt {
		font-weight: 500;
	}

	.failed-list {
		margin-top: 1rem;
		font-size: 0.875rem;
	}

	.failed-list ul {
		margin-top: 0.5rem;
		padding-left: 1.5rem;
		word-break: break-all;
	}

	.btn {
		padding: 0.5rem 1rem;
		border-radius: 4px;
		font-size: 0.875rem;
		cursor: pointer;
		border: none;
	}

	.btn-primary {
		background: var(--color-primary);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-secondary {
		background: var(--color-bg-secondary);
		color: var(--color-text);
		border: 1px solid var(--color-border);
	}

	.btn-secondary:hover {
		background: var(--color-border);
	}
</style>
