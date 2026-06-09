<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import NotificationList from './NotificationList.svelte';
  import { notificationsStore } from '$lib/stores/notifications.svelte';

  let open = $state(false);
  let rootRef: HTMLDivElement | null = $state(null);
  let btnRef: HTMLButtonElement | null = $state(null);
  // The panel uses position: fixed so it can escape the sidebar's overflow
  // clipping. We anchor it to the bell button's viewport rect.
  let panelLeft = $state(0);
  let panelTop = $state(0);

  const PANEL_WIDTH = 320;

  function positionPanel() {
    if (!btnRef) return;
    const rect = btnRef.getBoundingClientRect();
    const margin = 8;
    // Right-align the panel to the bell, but clamp within the viewport.
    let left = rect.right - PANEL_WIDTH;
    left = Math.min(left, window.innerWidth - PANEL_WIDTH - margin);
    left = Math.max(margin, left);
    panelLeft = left;
    panelTop = rect.bottom + 6;
  }

  function toggle() {
    if (open) {
      close();
    } else {
      positionPanel();
      open = true;
      // Load the list but keep unread highlighting while the panel is open, so
      // the user can see which mentions are new. They're marked seen on close.
      void notificationsStore.load();
    }
  }

  function onReposition() {
    if (open) positionPanel();
  }

  function close() {
    open = false;
    void notificationsStore.markAllSeen();
  }

  function onWindowPointerDown(e: PointerEvent) {
    if (open && rootRef && !rootRef.contains(e.target as Node)) close();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) close();
  }

  // Badge polling (notificationsStore.start/stop) is owned by the app shell in
  // +layout.svelte, not here — both this desktop bell and the mobile bottom-bar
  // bell are pure consumers, so neither can tear down the other's polling.
  onMount(() => {
    window.addEventListener('pointerdown', onWindowPointerDown);
    window.addEventListener('keydown', onKeydown);
    // Keep the fixed panel anchored to the bell as the sidebar/window scrolls.
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
  });
  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', onWindowPointerDown);
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    }
  });
</script>

<div class="notif" bind:this={rootRef}>
  <button
    class="notif-btn"
    class:active={open}
    onclick={toggle}
    bind:this={btnRef}
    aria-label="Notifications"
    title="Notifications"
  >
    <Icon name="bell" size={18} />
    {#if notificationsStore.unreadCount > 0}
      <span class="notif-badge"
        >{notificationsStore.unreadCount > 99 ? '99+' : notificationsStore.unreadCount}</span
      >
    {/if}
  </button>

  {#if open}
    <div class="notif-panel" role="menu" style="left: {panelLeft}px; top: {panelTop}px;">
      <div class="notif-panel-header">Notifications</div>
      <NotificationList onItemClick={close} />
    </div>
  {/if}
</div>

<style>
  .notif {
    position: relative;
    display: inline-flex;
  }

  .notif-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    background: none;
    border-radius: 6px;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  .notif-btn:hover,
  .notif-btn.active {
    background: var(--color-bg-secondary);
    color: var(--color-text);
  }

  .notif-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--color-primary);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
  }

  .notif-panel {
    position: fixed;
    width: 320px;
    max-height: 70vh;
    overflow-y: auto;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 1000;
  }

  .notif-panel-header {
    padding: 0.625rem 0.875rem;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    border-bottom: 1px solid var(--color-border);
  }
</style>
