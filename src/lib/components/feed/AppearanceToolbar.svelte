<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { preferences, type ArticleFont } from '$lib/stores/preferences.svelte';

	const fontOptions: { value: ArticleFont; label: string; family: string }[] = [
		{ value: 'sans-serif', label: 'Sans', family: 'sans-serif' },
		{ value: 'serif', label: 'Serif', family: 'serif' },
		{ value: 'mono', label: 'Mono', family: 'monospace' },
	];

	const sizeLabels: Record<string, string> = {
		xs: 'XS',
		sm: 'S',
		md: 'M',
		lg: 'L',
		xl: 'XL',
	};
</script>

<div class="appearance-toolbar" role="toolbar" aria-label="Appearance controls">
	<!-- Font Style -->
	<div class="toolbar-group">
		<span class="group-label">Font</span>
		<div class="segment-group" role="group" aria-label="Font style">
			{#each fontOptions as option}
				<button
					class="segment-btn"
					class:active={preferences.articleFont === option.value}
					onclick={() => preferences.setArticleFont(option.value)}
					title={option.label}
				>
					<span class="font-preview" style:font-family={option.family}>Aa</span>
				</button>
			{/each}
		</div>
	</div>

	<span class="toolbar-divider"></span>

	<!-- Font Size -->
	<div class="toolbar-group">
		<span class="group-label">Size</span>
		<div class="size-controls" role="group" aria-label="Font size">
			<button
				class="size-btn"
				onclick={() => preferences.decreaseFontSize()}
				disabled={preferences.articleFontSize === 'xs'}
				title="Decrease font size"
			>
				<Icon name="minus" size={14} />
			</button>
			<span class="size-label">{sizeLabels[preferences.articleFontSize]}</span>
			<button
				class="size-btn"
				onclick={() => preferences.increaseFontSize()}
				disabled={preferences.articleFontSize === 'xl'}
				title="Increase font size"
			>
				<Icon name="plus" size={14} />
			</button>
		</div>
	</div>
</div>

<style>
	.appearance-toolbar {
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

	.toolbar-group {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.group-label {
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding-left: 0.375rem;
		white-space: nowrap;
	}

	.toolbar-divider {
		width: 1px;
		height: 1rem;
		background: var(--color-border, #e0e0e0);
		margin: 0 0.25rem;
		opacity: 0.5;
	}

	.segment-group {
		display: flex;
		gap: 1px;
		border-radius: 999px;
	}

	.segment-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		padding: 0.35rem 0.5rem;
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

	.font-preview {
		font-size: 0.875rem;
		line-height: 1;
	}

	.size-controls {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}

	.size-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		padding: 0.3rem;
		border-radius: 999px;
		cursor: pointer;
		color: var(--color-text-secondary);
		transition: all 0.2s ease;
	}

	.size-btn:hover:not(:disabled) {
		color: var(--color-text);
		background: var(--color-bg-secondary, #f5f5f5);
	}

	.size-btn:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.size-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--color-text);
		min-width: 1.25rem;
		text-align: center;
	}

	/* Tablet: hide labels */
	@media (max-width: 900px) {
		.group-label {
			display: none;
		}
	}

	/* Mobile */
	@media (max-width: 640px) {
		.segment-btn {
			padding: 0.35rem 0.4rem;
		}
	}

	@media (prefers-color-scheme: dark) {
		.appearance-toolbar {
			background: rgba(40, 40, 40, 0.95);
		}

		.toolbar-divider {
			background: rgba(255, 255, 255, 0.2);
		}

		.segment-btn.active {
			background: rgba(255, 255, 255, 0.15);
		}

		.size-btn:hover:not(:disabled) {
			background: rgba(255, 255, 255, 0.1);
		}
	}
</style>
