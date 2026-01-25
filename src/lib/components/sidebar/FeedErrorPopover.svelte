<script lang="ts">
	import type { ErrorDetails } from '$lib/stores/feedStatus.svelte';

	interface Props {
		errorDetails: ErrorDetails;
		onRetry: () => void;
	}

	let { errorDetails, onRetry }: Props = $props();

	let retryCountdown = $derived.by(() => {
		if (!errorDetails.nextRetryAt) return null;
		const minutes = Math.max(0, Math.ceil((errorDetails.nextRetryAt - Date.now()) / 60000));
		if (minutes === 0) return 'less than a minute';
		if (minutes === 1) return '1 minute';
		return `${minutes} minutes`;
	});
</script>

<div class="error-popover">
	<div class="error-header" class:permanent={errorDetails.isPermanent}>
		<span class="error-icon">{errorDetails.isPermanent ? '!' : '~'}</span>
		<span class="error-title">{errorDetails.title}</span>
	</div>

	<p class="error-description">{errorDetails.description}</p>

	{#if errorDetails.errorCount > 1}
		<p class="error-meta">
			Failed {errorDetails.errorCount} times
		</p>
	{/if}

	{#if retryCountdown}
		<p class="error-meta">
			Auto-retry in {retryCountdown}
		</p>
	{/if}

	<div class="error-actions">
		<button class="retry-button" onclick={onRetry}> Retry Now </button>
	</div>

	{#if errorDetails.rawError}
		<details class="error-raw">
			<summary>Technical details</summary>
			<code>{errorDetails.rawError}</code>
		</details>
	{/if}
</div>

<style>
	.error-popover {
		width: 280px;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
		overflow: hidden;
	}

	.error-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--color-warning-bg, rgba(255, 152, 0, 0.1));
		border-bottom: 1px solid var(--color-border);
	}

	.error-header.permanent {
		background: var(--color-error-bg, rgba(244, 67, 54, 0.1));
	}

	.error-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		background: var(--color-warning, #ff9800);
		color: white;
		border-radius: 50%;
		font-size: 0.75rem;
		font-weight: bold;
		flex-shrink: 0;
	}

	.error-header.permanent .error-icon {
		background: var(--color-error);
	}

	.error-title {
		font-weight: 600;
		font-size: 0.875rem;
		color: var(--color-text);
	}

	.error-description {
		margin: 0;
		padding: 0.75rem 1rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
	}

	.error-meta {
		margin: 0;
		padding: 0 1rem 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-tertiary, var(--color-text-secondary));
	}

	.error-actions {
		padding: 0.5rem 1rem 0.75rem;
		border-top: 1px solid var(--color-border);
	}

	.retry-button {
		width: 100%;
		padding: 0.5rem 1rem;
		background: var(--color-primary);
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.retry-button:hover {
		background: var(--color-primary-hover, var(--color-primary));
		filter: brightness(1.1);
	}

	.error-raw {
		padding: 0 1rem 0.75rem;
		font-size: 0.75rem;
	}

	.error-raw summary {
		color: var(--color-text-tertiary, var(--color-text-secondary));
		cursor: pointer;
		user-select: none;
	}

	.error-raw summary:hover {
		color: var(--color-text-secondary);
	}

	.error-raw code {
		display: block;
		margin-top: 0.5rem;
		padding: 0.5rem;
		background: var(--color-bg-secondary);
		border-radius: 4px;
		font-family: monospace;
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
		word-break: break-all;
		white-space: pre-wrap;
	}

	@media (prefers-color-scheme: dark) {
		.error-popover {
			box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		}
	}
</style>
