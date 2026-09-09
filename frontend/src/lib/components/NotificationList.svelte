<script lang="ts">
  import Icon from './Icon.svelte';
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

  /** A notification about the reader's own feedback rather than about a person. */
  function isFeedback(n: SkyNotification): boolean {
    return n.type === 'feedback-status' || n.type === 'feedback-reply';
  }

  /**
   * The in-app destination of a notification, or null if it has none.
   *
   * Only our own feedback notifications point back into the app, and only a
   * path we wrote counts: a mention's URL comes from someone else's record, and
   * `//evil.com` (or `/\evil.com`) is a path to the eye and another origin to
   * the browser's resolver. Everything else goes through safeHref, which admits
   * nothing but an absolute http(s) URL.
   */
  function internalHref(n: SkyNotification): string | null {
    if (!isFeedback(n)) return null;
    const url = n.canonicalUrl ?? '';
    return /^\/(?![/\\])/.test(url) ? url : null;
  }
</script>

{#if notificationsStore.loading && !notificationsStore.loaded}
  <div class="notif-empty">Loading…</div>
{:else if notificationsStore.notifications.length === 0}
  <div class="notif-empty">
    Nothing yet. @mentions in shared articles, and news about feedback you've filed, show up here.
  </div>
{:else}
  <ul class="notif-list">
    {#each notificationsStore.notifications as n (n.id)}
      {@const internal = internalHref(n)}
      <li>
        <a
          class="notif-item"
          class:unread={!n.seen}
          href={internal ?? safeHref(n.canonicalUrl)}
          target={internal ? undefined : '_blank'}
          rel={internal ? undefined : 'noopener noreferrer'}
          onclick={onItemClick}
        >
          {#if isFeedback(n)}
            <div class="notif-avatar placeholder icon">
              <Icon name={n.type === 'feedback-reply' ? 'message-circle' : 'activity'} size={14} />
            </div>
          {:else if n.actorAvatar}
            <img class="notif-avatar" src={n.actorAvatar} alt="" />
          {:else}
            <div class="notif-avatar placeholder"></div>
          {/if}
          <div class="notif-body">
            <div class="notif-text">
              {#if isFeedback(n)}
                <strong>{n.detail}</strong> on your feedback{#if n.title}{' '}<span
                    class="notif-title">{n.title}</span
                  >{/if}
              {:else}
                <strong>{actorName(n)}</strong> mentioned you{#if n.title}{' '}on
                  <span class="notif-title">{n.title}</span>{/if}
              {/if}
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
  /* A feedback notification is about a post, not a person: the circle holds
     what happened rather than whose face it was. */
  .notif-avatar.icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
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
