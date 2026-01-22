<script lang="ts">
	import type { Snippet } from 'svelte';
	import LoadingState from '$lib/components/LoadingState.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';

	interface Props {
		isLoading: boolean;
		isEmpty: boolean;
		loadingMessage?: string;
		emptyTitle?: string;
		emptyDescription?: string;
		emptyIcon?: string;
		emptyActionHref?: string;
		emptyActionText?: string;
		children: Snippet;
		loading?: Snippet;
		empty?: Snippet;
	}

	let {
		isLoading,
		isEmpty,
		loadingMessage = 'Loading...',
		emptyTitle = 'Nothing here',
		emptyDescription = '',
		emptyIcon,
		emptyActionHref,
		emptyActionText,
		children,
		loading,
		empty,
	}: Props = $props();
</script>

{#if isLoading}
	{#if loading}
		{@render loading()}
	{:else}
		<LoadingState message={loadingMessage} />
	{/if}
{:else if isEmpty}
	{#if empty}
		{@render empty()}
	{:else}
		<EmptyState
			title={emptyTitle}
			description={emptyDescription}
			icon={emptyIcon}
			actionHref={emptyActionHref}
			actionText={emptyActionText}
		/>
	{/if}
{:else}
	{@render children()}
{/if}
