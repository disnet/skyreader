<script lang="ts">
	import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { socialStore } from '$lib/stores/social.svelte';
	import { profileService } from '$lib/services/profiles';
	import Modal from '$lib/components/common/Modal.svelte';
	import type { FilteredView, BlueskyProfile } from '$lib/types';

	interface Props {
		open: boolean;
		editingViewId: number | null;
		onclose: () => void;
	}

	let { open, editingViewId, onclose }: Props = $props();

	// Form state
	let name = $state('');
	let showArticles = $state(true);
	let showShares = $state(true);
	let showDocuments = $state(true);
	let feedMode = $state<'all' | 'include' | 'exclude'>('all');
	let feedIds = $state<Set<number>>(new Set());
	let accountMode = $state<'all' | 'include' | 'exclude'>('all');
	let accountDids = $state<Set<string>>(new Set());
	let readFilter = $state<'all' | 'unread' | 'read'>('all');
	let sortOrder = $state<'newest' | 'oldest'>('newest');
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Account profiles for display
	let accountProfiles = $state<Map<string, BlueskyProfile>>(new Map());

	// Load profiles for followed users
	$effect(() => {
		if (!open) return;
		const follows = socialStore.inAppFollows;
		for (const f of follows) {
			if (!accountProfiles.has(f.did)) {
				profileService.getProfile(f.did).then((p) => {
					if (p) {
						accountProfiles = new Map(accountProfiles).set(f.did, p);
					}
				});
			}
		}
	});

	// Reset form when modal opens or editingViewId changes
	$effect(() => {
		if (open) {
			if (editingViewId != null) {
				const view = filteredViewsStore.getById(editingViewId);
				if (view) {
					name = view.name;
					showArticles = view.showArticles;
					showShares = view.showShares;
					showDocuments = view.showDocuments;
					feedMode = view.feedMode;
					feedIds = new Set(view.feedIds);
					accountMode = view.accountMode;
					accountDids = new Set(view.accountDids);
					readFilter = view.readFilter;
					sortOrder = view.sortOrder;
					return;
				}
			}
			// New view defaults
			name = '';
			showArticles = true;
			showShares = true;
			showDocuments = true;
			feedMode = 'all';
			feedIds = new Set();
			accountMode = 'all';
			accountDids = new Set();
			readFilter = 'all';
			sortOrder = 'newest';
		}
	});

	function handleClose() {
		error = null;
		saving = false;
		onclose();
	}

	function toggleFeedId(id: number) {
		const next = new Set(feedIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		feedIds = next;
	}

	function toggleAccountDid(did: string) {
		const next = new Set(accountDids);
		if (next.has(did)) {
			next.delete(did);
		} else {
			next.add(did);
		}
		accountDids = next;
	}

	async function handleSave() {
		if (!name.trim()) {
			error = 'Name is required';
			return;
		}

		error = null;
		saving = true;

		try {
			const viewData = {
				name: name.trim(),
				showArticles,
				showShares,
				showDocuments,
				feedMode,
				feedIds: Array.from(feedIds),
				accountMode,
				accountDids: Array.from(accountDids),
				readFilter,
				sortOrder,
			};

			if (editingViewId != null) {
				await filteredViewsStore.update(editingViewId, viewData);
			} else {
				await filteredViewsStore.create(viewData);
			}

			handleClose();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save view';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} onclose={handleClose} title={editingViewId != null ? 'Edit View' : 'Create View'}>
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			handleSave();
		}}
	>
		<!-- Name -->
		<div class="form-group">
			<label for="view-name">Name</label>
			<input id="view-name" type="text" bind:value={name} placeholder="My view" required />
		</div>

		<!-- Content Types -->
		<div class="form-group">
			<span class="form-label">Content Types</span>
			<div class="checkbox-group">
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={showArticles} />
					Articles
				</label>
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={showShares} />
					Shares
				</label>
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={showDocuments} />
					Documents
				</label>
			</div>
		</div>

		<!-- Feed Filters -->
		{#if showArticles}
			<div class="form-group">
				<span class="form-label">Feed Filters</span>
				<div class="radio-group">
					<label class="radio-label">
						<input type="radio" bind:group={feedMode} value="all" />
						All feeds
					</label>
					<label class="radio-label">
						<input type="radio" bind:group={feedMode} value="include" />
						Include only
					</label>
					<label class="radio-label">
						<input type="radio" bind:group={feedMode} value="exclude" />
						Exclude
					</label>
				</div>
				{#if feedMode !== 'all'}
					<div class="checklist">
						{#each subscriptionsStore.subscriptions as sub (sub.id)}
							{#if sub.id != null}
								<label class="checklist-item">
									<input
										type="checkbox"
										checked={feedIds.has(sub.id)}
										onchange={() => toggleFeedId(sub.id!)}
									/>
									<span class="checklist-label">{sub.customTitle || sub.title}</span>
								</label>
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Account Filters -->
		{#if showShares || showDocuments}
			<div class="form-group">
				<span class="form-label">Account Filters</span>
				<div class="radio-group">
					<label class="radio-label">
						<input type="radio" bind:group={accountMode} value="all" />
						All accounts
					</label>
					<label class="radio-label">
						<input type="radio" bind:group={accountMode} value="include" />
						Include only
					</label>
					<label class="radio-label">
						<input type="radio" bind:group={accountMode} value="exclude" />
						Exclude
					</label>
				</div>
				{#if accountMode !== 'all'}
					<div class="checklist">
						{#each socialStore.inAppFollows as follow (follow.did)}
							{@const profile = accountProfiles.get(follow.did)}
							<label class="checklist-item">
								<input
									type="checkbox"
									checked={accountDids.has(follow.did)}
									onchange={() => toggleAccountDid(follow.did)}
								/>
								<span class="checklist-label">
									{#if profile}
										{profile.displayName || profile.handle}
									{:else}
										{follow.did.slice(0, 20)}...
									{/if}
								</span>
							</label>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Read State -->
		<div class="form-group">
			<span class="form-label">Read State</span>
			<div class="radio-group">
				<label class="radio-label">
					<input type="radio" bind:group={readFilter} value="all" />
					All
				</label>
				<label class="radio-label">
					<input type="radio" bind:group={readFilter} value="unread" />
					Unread only
				</label>
				<label class="radio-label">
					<input type="radio" bind:group={readFilter} value="read" />
					Read only
				</label>
			</div>
		</div>

		<!-- Sort Order -->
		<div class="form-group">
			<span class="form-label">Sort Order</span>
			<div class="radio-group">
				<label class="radio-label">
					<input type="radio" bind:group={sortOrder} value="newest" />
					Newest first
				</label>
				<label class="radio-label">
					<input type="radio" bind:group={sortOrder} value="oldest" />
					Oldest first
				</label>
			</div>
		</div>

		{#if error}
			<p class="error-message">{error}</p>
		{/if}

		<div class="button-row">
			<button type="button" class="btn-secondary" onclick={handleClose} disabled={saving}>
				Cancel
			</button>
			<button type="submit" class="btn-primary" disabled={saving}>
				{#if saving}
					Saving...
				{:else if editingViewId != null}
					Save
				{:else}
					Create
				{/if}
			</button>
		</div>
	</form>
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.form-group label[for],
	.form-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.form-group input[type='text'] {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-size: 0.875rem;
		background: var(--color-bg);
		color: var(--color-text);
	}

	.form-group input[type='text']:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
	}

	.checkbox-group,
	.radio-group {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.checkbox-label,
	.radio-label {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.875rem;
		font-weight: 400;
		color: var(--color-text);
		cursor: pointer;
	}

	.checklist {
		max-height: 160px;
		overflow-y: auto;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0.5rem;
		margin-top: 0.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.checklist-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.375rem;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.875rem;
	}

	.checklist-item:hover {
		background-color: var(--color-bg-hover, rgba(0, 0, 0, 0.05));
	}

	.checklist-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.error-message {
		color: var(--color-error);
		font-size: 0.875rem;
		margin: 0;
	}

	.button-row {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 0.5rem;
	}

	.btn-primary,
	.btn-secondary {
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.btn-primary {
		background: var(--color-primary);
		color: white;
		border: none;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--color-primary-dark, #0056b3);
	}

	.btn-primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-secondary {
		background: var(--color-bg);
		color: var(--color-text);
		border: 1px solid var(--color-border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--color-bg-secondary);
	}

	.btn-secondary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>
