<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		onclose: () => void;
		title?: string;
		maxWidth?: string;
		zIndex?: number;
		children: Snippet;
		header?: Snippet;
		footer?: Snippet;
	}

	let {
		open,
		onclose,
		title,
		maxWidth = '480px',
		zIndex = 100,
		children,
		header,
		footer,
	}: Props = $props();

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onclose();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onclose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="modal-backdrop"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		style:--modal-max-width={maxWidth}
		style:--modal-z-index={zIndex}
	>
		<div class="modal">
			{#if header}
				{@render header()}
			{:else if title}
				<div class="modal-header">
					<h2>{title}</h2>
					<button class="close-btn" onclick={onclose} aria-label="Close"> &times; </button>
				</div>
			{/if}

			<div class="modal-body">
				{@render children()}
			</div>

			{#if footer}
				<div class="modal-footer">
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--modal-z-index, 100);
		padding: 1rem;
	}

	.modal {
		background: var(--color-bg);
		border-radius: 8px;
		width: 100%;
		max-width: var(--modal-max-width, 480px);
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid var(--color-border);
	}

	.modal-header h2 {
		font-size: 1.25rem;
		margin: 0;
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: var(--color-text-secondary);
		padding: 0;
		line-height: 1;
		cursor: pointer;
	}

	.close-btn:hover {
		color: var(--color-text);
	}

	.modal-body {
		padding: 1.5rem;
		overflow-y: auto;
		flex: 1;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 1rem 1.5rem;
		border-top: 1px solid var(--color-border);
	}
</style>
