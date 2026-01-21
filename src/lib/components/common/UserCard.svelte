<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        avatarUrl?: string;
        displayName?: string;
        handle: string;
        size?: 'small' | 'medium' | 'large';
        variant?: 'inline' | 'card';
        showHandle?: boolean;
        dimmed?: boolean;
        badge?: Snippet;
        actions?: Snippet;
    }

    let {
        avatarUrl,
        displayName,
        handle,
        size = 'medium',
        variant = 'inline',
        showHandle = true,
        dimmed = false,
        badge,
        actions,
    }: Props = $props();

    const avatarSizes = {
        small: 20,
        medium: 32,
        large: 48,
    };

    let avatarSize = $derived(avatarSizes[size]);
</script>

<div
    class="user-card"
    class:variant-card={variant === 'card'}
    class:variant-inline={variant === 'inline'}
    class:dimmed
    style:--avatar-size="{avatarSize}px"
>
    {#if avatarUrl}
        <img src={avatarUrl} alt="" class="avatar" />
    {:else}
        <div class="avatar placeholder"></div>
    {/if}

    <div class="info">
        <span class="name">
            {displayName || handle}
            {#if badge}
                {@render badge()}
            {/if}
        </span>
        {#if showHandle && displayName}
            <span class="handle">@{handle}</span>
        {/if}
    </div>

    {#if actions}
        <div class="actions">
            {@render actions()}
        </div>
    {/if}
</div>

<style>
    .user-card {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
    }

    .user-card.dimmed {
        opacity: 0.6;
    }

    .user-card.variant-card {
        padding: 0.75rem;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 8px;
    }

    .avatar {
        width: var(--avatar-size);
        height: var(--avatar-size);
        border-radius: 50%;
        flex-shrink: 0;
        object-fit: cover;
    }

    .avatar.placeholder {
        background: var(--color-border);
    }

    .info {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1;
    }

    .name {
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .handle {
        font-size: 0.875rem;
        color: var(--color-text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .actions {
        flex-shrink: 0;
        margin-left: auto;
    }
</style>
