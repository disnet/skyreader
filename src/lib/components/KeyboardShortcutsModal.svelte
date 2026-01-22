<script lang="ts">
	import { keyboardStore } from '$lib/stores/keyboard.svelte';
	import Modal from '$lib/components/common/Modal.svelte';

	const shortcuts = [
		// Navigation
		{ category: 'Navigation', key: 'j', description: 'Next item' },
		{ category: 'Navigation', key: 'k', description: 'Previous item' },
		{ category: 'Navigation', key: 'Enter', description: 'Toggle expand' },
		{ category: 'Navigation', key: 'o', description: 'Open in new tab' },

		// Views
		{ category: 'Views', key: '1', description: 'All' },
		{ category: 'Views', key: '2', description: 'Starred' },
		{ category: 'Views', key: '3', description: 'Shared' },
		{ category: 'Views', key: '4', description: 'Feeds' },
		{ category: 'Views', key: '5', description: 'Following' },
		{ category: 'Views', key: '6', description: 'Discover' },
		{ category: 'Views', key: '0', description: 'Settings' },

		// Feed/User cycling
		{ category: 'Feed/User', key: '[', description: 'Previous feed/user' },
		{ category: 'Feed/User', key: ']', description: 'Next feed/user' },

		// Article actions
		{ category: 'Article', key: 's', description: 'Toggle star' },
		{ category: 'Article', key: 'S', description: 'Share/unshare' },
		{ category: 'Article', key: 'm', description: 'Mark read/unread' },
		{ category: 'Article', key: '+', description: 'Increase font size' },
		{ category: 'Article', key: '_', description: 'Decrease font size' },
		{ category: 'Article', key: ')', description: 'Reset font size' },

		// Other
		{ category: 'Other', key: 'u', description: 'Toggle unread filter' },
		{ category: 'Other', key: 'a', description: 'Add feed' },
		{ category: 'Other', key: '?', description: 'Show shortcuts' },
		{ category: 'Other', key: 'Esc', description: 'Close modal / Deselect' },
	];

	const categories = ['Navigation', 'Views', 'Feed/User', 'Article', 'Other'];
</script>

<Modal
	open={keyboardStore.isHelpOpen}
	onclose={() => keyboardStore.closeHelp()}
	title="Keyboard Shortcuts"
	maxWidth="600px"
	zIndex={200}
>
	<div class="shortcuts-grid">
		{#each categories as category}
			{@const categoryShortcuts = shortcuts.filter((s) => s.category === category)}
			<div class="category">
				<h3>{category}</h3>
				<div class="shortcut-list">
					{#each categoryShortcuts as shortcut}
						<div class="shortcut">
							<kbd>{shortcut.key}</kbd>
							<span>{shortcut.description}</span>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</Modal>

<style>
	.shortcuts-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 1.5rem;
	}

	.category h3 {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-text-secondary);
		margin: 0 0 0.75rem 0;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.shortcut-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.shortcut {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.shortcut kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.75rem;
		height: 1.5rem;
		padding: 0 0.375rem;
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		box-shadow: 0 1px 0 var(--color-border);
	}

	.shortcut span {
		font-size: 0.875rem;
		color: var(--color-text);
	}

	@media (max-width: 480px) {
		.shortcuts-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
