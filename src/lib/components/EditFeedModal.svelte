<script lang="ts">
	import { subscriptionsStore } from '$lib/stores/subscriptions.svelte';
	import { getFaviconUrl } from '$lib/utils/favicon';
	import Modal from '$lib/components/common/Modal.svelte';
	import type { Subscription } from '$lib/types';

	interface Props {
		open: boolean;
		subscription: Subscription | null;
		onclose: () => void;
	}

	let { open, subscription, onclose }: Props = $props();

	let customTitle = $state('');
	let iconUrl = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Reset form when subscription changes
	$effect(() => {
		if (subscription) {
			// Use customTitle if set, otherwise empty (placeholder shows original title)
			customTitle = subscription.customTitle || '';
			iconUrl = subscription.customIconUrl || '';
		}
	});

	// Preview URL: custom iconUrl if set, otherwise auto-detected favicon
	let previewUrl = $derived(
		iconUrl.trim() || getFaviconUrl(subscription?.siteUrl || subscription?.feedUrl || '')
	);

	let iconLoaded = $state(false);
	let iconError = $state(false);

	// Reset icon state when preview URL changes
	$effect(() => {
		previewUrl;
		iconLoaded = false;
		iconError = false;
	});

	function handleIconLoad() {
		iconLoaded = true;
		iconError = false;
	}

	function handleIconError() {
		iconLoaded = true;
		iconError = true;
	}

	function handleResetIcon() {
		iconUrl = '';
	}

	function handleResetTitle() {
		customTitle = '';
	}

	function handleClose() {
		customTitle = '';
		iconUrl = '';
		error = null;
		saving = false;
		onclose();
	}

	async function handleSave() {
		if (!subscription?.id) return;

		error = null;
		saving = true;

		try {
			// Local-only update - no backend sync
			await subscriptionsStore.updateLocal(subscription.id, {
				customTitle: customTitle.trim() || undefined,
				customIconUrl: iconUrl.trim() || undefined,
			});
			handleClose();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save changes';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} onclose={handleClose} title="Edit Feed">
	{#if subscription}
		<form
			class="form"
			onsubmit={(e) => {
				e.preventDefault();
				handleSave();
			}}
		>
			<div class="form-group">
				<label for="feed-title">Custom Title</label>
				<div class="title-input-row">
					<input
						id="feed-title"
						type="text"
						bind:value={customTitle}
						placeholder={subscription.title}
					/>
					{#if customTitle.trim()}
						<button type="button" class="reset-btn" onclick={handleResetTitle}> Reset </button>
					{/if}
				</div>
				<p class="help-text">Original: {subscription.title}</p>
			</div>

			<div class="form-group">
				<label for="feed-icon">Custom Icon URL</label>
				<div class="icon-input-row">
					<input
						id="feed-icon"
						type="url"
						bind:value={iconUrl}
						placeholder="https://example.com/icon.png"
					/>
					{#if iconUrl.trim()}
						<button type="button" class="reset-btn" onclick={handleResetIcon}> Reset </button>
					{/if}
				</div>
				<p class="help-text">Leave empty to use the auto-detected favicon</p>
			</div>

			<div class="icon-preview">
				<span class="preview-label">Preview:</span>
				{#if previewUrl}
					<div class="preview-icon-container">
						{#if !iconLoaded}
							<div class="preview-loading"></div>
						{/if}
						<img
							src={previewUrl}
							alt="Feed icon"
							class="preview-icon"
							class:loaded={iconLoaded && !iconError}
							class:error={iconError}
							onload={handleIconLoad}
							onerror={handleIconError}
						/>
						{#if iconError}
							<span class="preview-error">Failed to load</span>
						{/if}
					</div>
				{:else}
					<div class="preview-placeholder"></div>
				{/if}
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
					{:else}
						Save
					{/if}
				</button>
			</div>
		</form>
	{/if}
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

	.form-group label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.form-group input {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-size: 0.875rem;
		background: var(--color-bg);
		color: var(--color-text);
	}

	.form-group input:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
	}

	.title-input-row,
	.icon-input-row {
		display: flex;
		gap: 0.5rem;
	}

	.title-input-row input,
	.icon-input-row input {
		flex: 1;
	}

	.reset-btn {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-bg-secondary);
		color: var(--color-text-secondary);
		font-size: 0.875rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.reset-btn:hover {
		background: var(--color-bg);
		color: var(--color-text);
	}

	.help-text {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		margin: 0;
	}

	.icon-preview {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem;
		background: var(--color-bg-secondary);
		border-radius: 6px;
	}

	.preview-label {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.preview-icon-container {
		position: relative;
		width: 32px;
		height: 32px;
	}

	.preview-loading {
		position: absolute;
		inset: 0;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-primary);
		border-radius: 4px;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.preview-icon {
		width: 32px;
		height: 32px;
		border-radius: 4px;
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	.preview-icon.loaded {
		opacity: 1;
	}

	.preview-icon.error {
		opacity: 0.3;
	}

	.preview-error {
		font-size: 0.75rem;
		color: var(--color-error);
		margin-left: 0.5rem;
	}

	.preview-placeholder {
		width: 32px;
		height: 32px;
		background: var(--color-border);
		border-radius: 4px;
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
