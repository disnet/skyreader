<script lang="ts">
  import { notificationsStore } from '$lib/stores/notifications.svelte';
  import { formatRelativeTime } from '$lib/utils/date';
  import { safeHref } from '$lib/utils/sanitize';
  import type { SkyNotification } from '$lib/types';

  interface Props {
    // Called after a notification is opened, so the host chrome (desktop dropdown
    // or mobile sheet) can dismiss itself.
    onItemClick: () => void;
  }

  let { onItemClick }: Props = $props();

  function actorName(n: SkyNotification): string {
    return n.actorDisplayName || (n.actorHandle ? `@${n.actorHandle}` : 'Someone');
  }
</script>

{#if notificationsStore.loading && !notificationsStore.loaded}
  <div class="notif-empty">Loading…</div>
{:else if notificationsStore.notifications.length === 0}
  <div class="notif-empty">
    Nothing yet. When someone @mentions you in a shared article, it shows up here.
  </div>
{:else}
  <ul class="notif-list">
    {#each notificationsStore.notifications as n (n.id)}
      <li>
        <a
          class="notif-item"
          class:unread={!n.seen}
          href={safeHref(n.canonicalUrl)}
          target="_blank"
          rel="noopener noreferrer"
          onclick={onItemClick}
        >
          {#if n.actorAvatar}
            <img class="notif-avatar" src={n.actorAvatar} alt="" />
          {:else}
            <div class="notif-avatar placeholder"></div>
          {/if}
          <div class="notif-body">
            <div class="notif-text">
              <strong>{actorName(n)}</strong> mentioned you{#if n.title}{' '}on
                <span class="notif-title">{n.title}</span>{/if}
            </div>
            <div class="notif-time">{formatRelativeTime(n.createdAt)}</div>
          </div>
        </a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .notif-empty {
    padding: 1.25rem 0.875rem;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    line-height: 1.4;
  }

  .notif-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .notif-item {
    display: flex;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    text-decoration: none;
    color: inherit;
    border-bottom: 1px solid var(--color-border);
  }
  .notif-item:hover {
    background: var(--color-bg-secondary);
  }
  .notif-item.unread {
    background: color-mix(in srgb, var(--color-primary) 7%, transparent);
  }
  .notif-item.unread:hover {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  }

  .notif-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }
  .notif-avatar.placeholder {
    background: var(--color-bg-secondary);
  }

  .notif-body {
    min-width: 0;
    flex: 1;
  }
  .notif-text {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.35;
  }
  .notif-title {
    color: var(--color-text-secondary);
  }
  .notif-time {
    margin-top: 2px;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }
</style>
